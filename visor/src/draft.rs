use std::collections::{BTreeMap, BTreeSet};

pub(crate) fn rebase_map(
    latest: &mut BTreeMap<String, String>,
    baseline: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
) {
    let keys: BTreeSet<String> = baseline.keys().chain(current.keys()).cloned().collect();
    for key in keys {
        if baseline.get(&key) != current.get(&key) {
            match current.get(&key) {
                Some(value) => {
                    latest.insert(key, value.clone());
                }
                None => {
                    latest.remove(&key);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_fields_survive_while_clean_fields_follow_latest() {
        let baseline = BTreeMap::from([
            ("dirty".into(), "old".into()),
            ("clean".into(), "old".into()),
        ]);
        let current = BTreeMap::from([
            ("dirty".into(), "typed".into()),
            ("clean".into(), "old".into()),
        ]);
        let mut latest = BTreeMap::from([
            ("dirty".into(), "remote".into()),
            ("clean".into(), "remote".into()),
        ]);
        rebase_map(&mut latest, &baseline, &current);
        assert_eq!(latest["dirty"], "typed");
        assert_eq!(latest["clean"], "remote");
    }
}
