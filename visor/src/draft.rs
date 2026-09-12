use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum RollTarget {
    Device,
    User,
    App(String),
    Contact(String),
    Picker,
}

#[derive(Clone, Default)]
pub(crate) struct RollState {
    values: BTreeMap<RollTarget, BTreeSet<String>>,
}

impl RollState {
    pub(crate) fn invalidate(&mut self, target: &RollTarget) {
        self.values.remove(target);
    }
    pub(crate) fn is_active(&self, target: &RollTarget, current: &str) -> bool {
        self.values
            .get(target)
            .is_some_and(|values| values.contains(current))
    }
    pub(crate) fn activate(&mut self, target: RollTarget, value: String) {
        self.values.entry(target).or_default().insert(value);
    }
}

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

    #[test]
    fn roll_eligibility_is_targeted_value_checked_and_manually_invalidated() {
        let mut rolls = RollState::default();
        let app_a = RollTarget::App("a".into());
        let app_b = RollTarget::App("b".into());
        rolls.activate(app_a.clone(), "rolled".into());
        assert!(rolls.is_active(&app_a, "rolled"));
        assert!(!rolls.is_active(&app_b, "rolled"));
        assert!(!rolls.is_active(&app_a, "remote"));
        rolls.activate(app_a.clone(), "rerolled".into());
        assert!(rolls.is_active(&app_a, "rolled"));
        rolls.invalidate(&app_a);
        assert!(!rolls.is_active(&app_a, "rolled"));
    }
}
