use crate::casemap::CaseMapping;

/// What `RPL_ISUPPORT` told us, pre-seeded with the RFC defaults so a server
/// that sends no 005 at all still parses channel names and member prefixes.
#[derive(Debug, Clone)]
pub struct ISupport {
    pub casemapping: CaseMapping,
    pub chantypes: String,
    /// Mode letter and its prefix character, highest rank first.
    pub prefixes: Vec<(char, char)>,
    /// The four `CHANMODES` classes: list, always-argument, argument on set, flag.
    pub chanmodes: [String; 4],
    pub network: Option<String>,
    /// Prefixes a message target may carry to reach a slice of a channel:
    /// Libera's `STATUSMSG=@+` makes `@#chan` the ops of `#chan`. Empty when
    /// the server names none, which is the RFC default.
    pub statusmsg: String,
    /// The most history one `CHATHISTORY` may ask for. `None` is the server
    /// stating no limit, not a limit of zero.
    pub chathistory: Option<u32>,
    targmax: Vec<(String, Option<u32>)>,
}

impl Default for ISupport {
    fn default() -> Self {
        Self {
            casemapping: CaseMapping::default(),
            chantypes: "#&".into(),
            prefixes: vec![('o', '@'), ('v', '+')],
            chanmodes: ["b".into(), "k".into(), "l".into(), "imnpst".into()],
            network: None,
            statusmsg: String::new(),
            chathistory: None,
            targmax: Vec::new(),
        }
    }
}

impl ISupport {
    /// The parameters of one 005 line, without the leading nick and the
    /// trailing "are supported by this server".
    pub fn apply(&mut self, tokens: &[String]) {
        for token in tokens {
            if let Some(name) = token.strip_prefix('-') {
                self.reset(name);
                continue;
            }
            let (key, value) = match token.split_once('=') {
                Some((key, value)) => (key, value),
                None => (token.as_str(), ""),
            };
            self.set(&key.to_ascii_uppercase(), value);
        }
    }

    fn set(&mut self, key: &str, value: &str) {
        match key {
            "CASEMAPPING" => {
                if let Some(mapping) = CaseMapping::from_token(value) {
                    self.casemapping = mapping;
                }
            }
            "CHANTYPES" if !value.is_empty() => self.chantypes = value.into(),
            "PREFIX" => self.prefixes = parse_prefix(value),
            "CHANMODES" => {
                for (slot, class) in self.chanmodes.iter_mut().zip(value.split(',')) {
                    *slot = class.into();
                }
            }
            "NETWORK" if !value.is_empty() => self.network = Some(value.into()),
            "STATUSMSG" => self.statusmsg = value.into(),
            // Ergo sends `CHATHISTORY=1000` and `draft/CHATHISTORY=1000` while
            // the capability is still a draft; either is the same statement.
            "CHATHISTORY" | "DRAFT/CHATHISTORY" => self.chathistory = value.parse().ok(),
            "TARGMAX" => self.targmax = parse_targmax(value),
            _ => {}
        }
    }

    fn reset(&mut self, key: &str) {
        let defaults = ISupport::default();
        match key.to_ascii_uppercase().as_str() {
            "CASEMAPPING" => self.casemapping = defaults.casemapping,
            "CHANTYPES" => self.chantypes = defaults.chantypes,
            "PREFIX" => self.prefixes = defaults.prefixes,
            "CHANMODES" => self.chanmodes = defaults.chanmodes,
            "NETWORK" => self.network = None,
            "STATUSMSG" => self.statusmsg = defaults.statusmsg,
            "CHATHISTORY" | "DRAFT/CHATHISTORY" => self.chathistory = None,
            "TARGMAX" => self.targmax = Vec::new(),
            _ => {}
        }
    }

    pub fn is_channel(&self, target: &str) -> bool {
        target
            .chars()
            .next()
            .is_some_and(|c| self.chantypes.contains(c))
    }

    /// The channel a `STATUSMSG`-prefixed target reaches: `@#chan` is
    /// `#chan`, spoken only to its ops. `None` when the target carries no
    /// such prefix, or what is left is not a channel.
    pub fn statusmsg_channel<'a>(&self, target: &'a str) -> Option<&'a str> {
        let channel = target.trim_start_matches(|c| self.statusmsg.contains(c));
        (channel.len() < target.len() && self.is_channel(channel)).then_some(channel)
    }

    pub fn prefix_for_mode(&self, mode: char) -> Option<char> {
        self.prefixes
            .iter()
            .find(|(letter, _)| *letter == mode)
            .map(|(_, prefix)| *prefix)
    }

    pub fn is_prefix(&self, c: char) -> bool {
        self.prefixes.iter().any(|(_, prefix)| *prefix == c)
    }

    /// Lower is higher standing: `@` outranks `+`.
    pub fn rank(&self, prefix: char) -> usize {
        self.prefixes
            .iter()
            .position(|(_, p)| *p == prefix)
            .unwrap_or(usize::MAX)
    }

    /// How many targets one command may name. `None` means no stated limit.
    pub fn targmax(&self, command: &str) -> Option<u32> {
        self.targmax
            .iter()
            .find(|(name, _)| name == command)
            .and_then(|(_, limit)| *limit)
    }

    /// Splits the leading membership prefixes off a `RPL_NAMREPLY` entry.
    /// Without `multi-prefix` only the highest one is there to find.
    pub fn split_prefixes<'a>(&self, entry: &'a str) -> (Vec<String>, &'a str) {
        let end = entry
            .char_indices()
            .find(|(_, c)| !self.is_prefix(*c))
            .map(|(index, _)| index)
            .unwrap_or(entry.len());
        let prefixes = entry[..end].chars().map(String::from).collect();
        (prefixes, &entry[end..])
    }

    /// Mode letters that carry an argument when set, taken from `CHANMODES`
    /// classes A-C plus the membership modes from `PREFIX`.
    pub fn takes_argument(&self, mode: char, adding: bool) -> bool {
        if self.prefixes.iter().any(|(letter, _)| *letter == mode) {
            return true;
        }
        if self.chanmodes[0].contains(mode) || self.chanmodes[1].contains(mode) {
            return true;
        }
        adding && self.chanmodes[2].contains(mode)
    }
}

fn parse_prefix(value: &str) -> Vec<(char, char)> {
    let Some((modes, prefixes)) = value.strip_prefix('(').and_then(|v| v.split_once(')')) else {
        return Vec::new();
    };
    modes.chars().zip(prefixes.chars()).collect()
}

fn parse_targmax(value: &str) -> Vec<(String, Option<u32>)> {
    value
        .split(',')
        .filter_map(|entry| entry.split_once(':'))
        .map(|(command, limit)| (command.to_ascii_uppercase(), limit.parse().ok()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(line: &str) -> Vec<String> {
        line.split(' ').map(String::from).collect()
    }

    /// The three 005 lines `irc.libera.chat` sent on 2026-07-30, verbatim.
    #[test]
    fn a_libera_005_lands_in_every_field() {
        let mut isupport = ISupport::default();
        isupport.apply(&tokens(
            "ETRACE KNOCK SAFELIST ELIST=CMNTU MONITOR=100 FNC WHOX CALLERID=g \
             ACCOUNTEXTBAN=a CHANTYPES=# EXCEPTS INVEX",
        ));
        isupport.apply(&tokens(
            "CHANMODES=eIbq,k,flj,CFLMPQRSTcgimnprstuz CHANLIMIT=#:250 PREFIX=(ov)@+ \
             MAXLIST=bqeI:100 MODES=4 NETWORK=Libera.Chat STATUSMSG=@+ CASEMAPPING=rfc1459 \
             NICKLEN=16 MAXNICKLEN=16 CHANNELLEN=50 TOPICLEN=390",
        ));
        isupport.apply(&tokens(
            "DEAF=D TARGMAX=NAMES:1,LIST:1,KICK:1,WHOIS:1,PRIVMSG:4,NOTICE:4,ACCEPT:,MONITOR: \
             EXTBAN=$,agjrxz CLIENTTAGDENY=*,-typing",
        ));

        assert_eq!(isupport.chantypes, "#");
        assert_eq!(isupport.prefixes, vec![('o', '@'), ('v', '+')]);
        assert_eq!(isupport.chanmodes[0], "eIbq");
        assert_eq!(isupport.chanmodes[3], "CFLMPQRSTcgimnprstuz");
        assert_eq!(isupport.casemapping, CaseMapping::Rfc1459);
        assert_eq!(isupport.network.as_deref(), Some("Libera.Chat"));
        assert_eq!(isupport.statusmsg, "@+");
        assert_eq!(isupport.statusmsg_channel("@#chan"), Some("#chan"));
        assert_eq!(isupport.statusmsg_channel("+#chan"), Some("#chan"));
        // A prefix has to leave a channel behind, and a bare channel or nick
        // carries none.
        assert_eq!(isupport.statusmsg_channel("#chan"), None);
        assert_eq!(isupport.statusmsg_channel("@nick"), None);
        assert_eq!(isupport.targmax("PRIVMSG"), Some(4));
        assert_eq!(isupport.targmax("KICK"), Some(1));
        // `ACCEPT:` states no limit; `JOIN` is not listed at all.
        assert_eq!(isupport.targmax("ACCEPT"), None);
        assert_eq!(isupport.targmax("JOIN"), None);
    }

    #[test]
    fn a_negated_token_restores_the_default() {
        let mut isupport = ISupport::default();
        isupport.apply(&tokens("CHANTYPES=#&! NETWORK=Example"));
        isupport.apply(&tokens("-CHANTYPES -NETWORK"));

        assert_eq!(isupport.chantypes, "#&");
        assert_eq!(isupport.network, None);
    }

    #[test]
    fn multi_prefix_entries_split_down_to_the_nick() {
        let mut isupport = ISupport::default();
        isupport.apply(&tokens("PREFIX=(qaohv)~&@%+"));

        let (prefixes, nick) = isupport.split_prefixes("~@sable");
        assert_eq!(prefixes, vec!["~", "@"]);
        assert_eq!(nick, "sable");
        assert_eq!(isupport.split_prefixes("sable").0, Vec::<String>::new());
        assert!(isupport.rank('~') < isupport.rank('+'));
    }

    #[test]
    fn a_server_that_sends_nothing_still_knows_a_channel_from_a_nick() {
        let isupport = ISupport::default();
        assert!(isupport.is_channel("#ircx"));
        assert!(!isupport.is_channel("sable"));
        assert_eq!(isupport.prefix_for_mode('o'), Some('@'));
        // And names no STATUSMSG prefixes: without the token nothing is
        // stripped, so `@#chan` stays whatever the classifier made of it.
        assert_eq!(isupport.statusmsg_channel("@#chan"), None);
    }
}
