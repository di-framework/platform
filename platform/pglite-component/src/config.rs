//! Provider-side connection configuration.
//!
//! The guest passes `host:port` or `host:port/database` as the `open` path;
//! everything else (including the password, which never crosses the WIT
//! boundary) comes from the provider's own environment.

pub struct Cfg {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
}

fn env_or(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

impl Cfg {
    pub fn from_env() -> Self {
        let port = std::env::var("PGPORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(5432);
        Self {
            host: env_or("PGHOST", "127.0.0.1"),
            port,
            user: env_or("PGUSER", "postgres"),
            password: env_or("PGPASSWORD", "password"),
            database: env_or("PGDATABASE", "template1"),
        }
    }
}

/// Split an `open` path into `(host, port, database)`, falling back to `cfg`.
pub fn parse_target(path: &str, cfg: &Cfg) -> (String, u16, String) {
    if path.is_empty() {
        return (cfg.host.clone(), cfg.port, cfg.database.clone());
    }
    let (authority, db) = match path.split_once('/') {
        Some((a, d)) if !d.is_empty() => (a, d.to_string()),
        Some((a, _)) => (a, cfg.database.clone()),
        None => (path, cfg.database.clone()),
    };
    let (host, port) = split_host_port(authority, cfg);
    (host, port, db)
}

fn split_host_port(authority: &str, cfg: &Cfg) -> (String, u16) {
    // Bracketed IPv6: [::1] or [::1]:5432.
    if let Some(rest) = authority.strip_prefix('[') {
        if let Some((inside, after)) = rest.split_once(']') {
            let port = after
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(cfg.port);
            return (inside.to_string(), port);
        }
    }
    // A bare IPv6 literal holds several colons and no port.
    if authority.matches(':').count() != 1 {
        return (authority.to_string(), cfg.port);
    }
    match authority.split_once(':') {
        Some((h, p)) if !h.is_empty() => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            Err(_) => (authority.to_string(), cfg.port),
        },
        _ => (authority.to_string(), cfg.port),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Cfg {
        Cfg {
            host: "db.internal".to_string(),
            port: 5433,
            user: "u".to_string(),
            password: "p".to_string(),
            database: "app".to_string(),
        }
    }

    #[test]
    fn empty_path_selects_provider_defaults() {
        assert_eq!(
            parse_target("", &cfg()),
            ("db.internal".to_string(), 5433, "app".to_string())
        );
    }

    #[test]
    fn host_port_and_database_override() {
        assert_eq!(
            parse_target("other:5434/otherdb", &cfg()),
            ("other".to_string(), 5434, "otherdb".to_string())
        );
    }

    #[test]
    fn bare_host_keeps_default_port_and_db() {
        assert_eq!(
            parse_target("other", &cfg()),
            ("other".to_string(), 5433, "app".to_string())
        );
    }

    #[test]
    fn ipv6_literals() {
        assert_eq!(
            parse_target("[::1]:5434/app", &cfg()),
            ("::1".to_string(), 5434, "app".to_string())
        );
        assert_eq!(
            parse_target("::1", &cfg()),
            ("::1".to_string(), 5433, "app".to_string())
        );
    }
}
