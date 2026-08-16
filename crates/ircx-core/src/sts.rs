#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Advertisement {
    pub(crate) port: Option<u16>,
    pub(crate) duration: Option<u64>,
}

pub(crate) fn parse(value: &str) -> Option<Advertisement> {
    let mut advertisement = Advertisement {
        port: None,
        duration: None,
    };

    for token in value.split(',') {
        let (key, value) = token.split_once('=').unwrap_or((token, ""));
        match key {
            "port" if advertisement.port.is_none() => {
                advertisement.port = value.parse::<u16>().ok().filter(|port| *port != 0);
                advertisement.port?;
            }
            "duration" if advertisement.duration.is_none() => {
                advertisement.duration = value.parse().ok();
                advertisement.duration?;
            }
            "port" | "duration" => return None,
            _ => {}
        }
    }

    Some(advertisement)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_fields_are_read_with_unknown_fields_ignored() {
        assert_eq!(
            parse("duration=3600,preload,port=6697,future=value"),
            Some(Advertisement {
                port: Some(6697),
                duration: Some(3600),
            })
        );
    }

    #[test]
    fn an_invalid_known_field_invalidates_the_advertisement() {
        assert_eq!(parse("port=0,duration=3600"), None);
        assert_eq!(parse("port=not-a-port"), None);
        assert_eq!(parse("duration=-1"), None);
    }

    #[test]
    fn a_known_field_may_not_repeat() {
        assert_eq!(parse("duration=1,duration=2"), None);
        assert_eq!(parse("port=6697,port=7000"), None);
    }
}
