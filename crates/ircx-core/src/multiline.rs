#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Limits {
    pub(crate) max_bytes: usize,
    pub(crate) max_lines: Option<usize>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Component {
    pub(crate) text: String,
    pub(crate) concat: bool,
}

pub(crate) fn components(
    text: &str,
    budget: usize,
    limits: Limits,
) -> Option<(String, Vec<Component>)> {
    let text = text
        .split('\n')
        .map(|line| line.replace(['\0', '\r'], ""))
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() || text.len() > limits.max_bytes {
        return None;
    }

    let budget = budget.max(1);
    let mut components = Vec::new();
    for line in text.split('\n') {
        if line.is_empty() {
            components.push(Component {
                text: String::new(),
                concat: false,
            });
            continue;
        }
        let mut rest = line;
        let mut concat = false;
        while !rest.is_empty() {
            let mut end = rest.len().min(budget);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            if end == 0 {
                end = rest.chars().next().map_or(rest.len(), char::len_utf8);
            }
            components.push(Component {
                text: rest[..end].to_string(),
                concat,
            });
            rest = &rest[end..];
            concat = true;
        }
    }

    if components.len() <= 1 || limits.max_lines.is_some_and(|max| components.len() > max) {
        return None;
    }
    Some((text, components))
}

pub(crate) fn limits(value: &str) -> Option<Limits> {
    let mut max_bytes = None;
    let mut max_lines = None;

    for field in value.split(',') {
        let Some((name, value)) = field.split_once('=') else {
            continue;
        };
        let slot = match name {
            "max-bytes" => &mut max_bytes,
            "max-lines" => &mut max_lines,
            _ => continue,
        };
        if slot.is_some() {
            return None;
        }
        *slot = value.parse::<usize>().ok().filter(|value| *value > 0);
        if slot.is_none() {
            return None;
        }
    }

    Some(Limits {
        max_bytes: max_bytes?,
        max_lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_required_and_optional_limits() {
        assert_eq!(
            limits("max-bytes=4096,max-lines=100"),
            Some(Limits {
                max_bytes: 4096,
                max_lines: Some(100),
            })
        );
        assert_eq!(
            limits("vendor=x,max-bytes=2048"),
            Some(Limits {
                max_bytes: 2048,
                max_lines: None,
            })
        );
    }

    #[test]
    fn rejects_missing_invalid_and_duplicate_limits() {
        assert_eq!(limits("max-lines=10"), None);
        assert_eq!(limits("max-bytes=0"), None);
        assert_eq!(limits("max-bytes=many"), None);
        assert_eq!(limits("max-bytes=10,max-bytes=20"), None);
        assert_eq!(limits("max-bytes=10,max-lines=0"), None);
    }

    #[test]
    fn preserves_lines_blanks_spaces_and_unicode_when_fragmenting() {
        let limits = Limits {
            max_bytes: 100,
            max_lines: None,
        };
        let (text, parts) = components("one  two\r\n\n🙂🙂", 5, limits).unwrap();

        assert_eq!(text, "one  two\n\n🙂🙂");
        assert_eq!(
            parts,
            vec![
                Component {
                    text: "one  ".into(),
                    concat: false
                },
                Component {
                    text: "two".into(),
                    concat: true
                },
                Component {
                    text: "".into(),
                    concat: false
                },
                Component {
                    text: "🙂".into(),
                    concat: false
                },
                Component {
                    text: "🙂".into(),
                    concat: true
                },
            ]
        );
    }

    #[test]
    fn declines_messages_outside_the_advertised_limits() {
        assert!(components(
            "six bytes",
            20,
            Limits {
                max_bytes: 5,
                max_lines: None
            }
        )
        .is_none());
        assert!(components(
            "one\ntwo",
            20,
            Limits {
                max_bytes: 20,
                max_lines: Some(1)
            }
        )
        .is_none());
    }
}
