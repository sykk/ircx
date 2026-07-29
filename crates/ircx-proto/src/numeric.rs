pub const RPL_WELCOME: u16 = 1;
pub const RPL_ISUPPORT: u16 = 5;
pub const RPL_TOPIC: u16 = 332;
pub const RPL_NAMREPLY: u16 = 353;
pub const RPL_ENDOFNAMES: u16 = 366;
pub const ERR_NICKNAMEINUSE: u16 = 433;

pub const RPL_LOGGEDIN: u16 = 900;
pub const RPL_LOGGEDOUT: u16 = 901;
pub const ERR_NICKLOCKED: u16 = 902;
pub const RPL_SASLSUCCESS: u16 = 903;
pub const ERR_SASLFAIL: u16 = 904;
pub const ERR_SASLTOOLONG: u16 = 905;
pub const ERR_SASLABORTED: u16 = 906;
pub const ERR_SASLALREADY: u16 = 907;
pub const RPL_SASLMECHS: u16 = 908;

/// Every numeric that ends a SASL exchange, successfully or not.
pub fn is_sasl(code: u16) -> bool {
    (RPL_LOGGEDIN..=RPL_SASLMECHS).contains(&code)
}
