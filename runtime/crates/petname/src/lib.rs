use std::sync::LazyLock;

const WORDS: &str = include_str!("../eff_short_wordlist.txt");
static WORD_LIST: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| WORDS.lines().filter(|word| !word.is_empty()).collect());

/// Select a petname from the EFF short word list, excluding `previous`.
pub fn generate(mut draw: impl FnMut() -> u32, previous: &str) -> String {
    loop {
        let petname = WORD_LIST[draw() as usize % WORD_LIST.len()];
        if petname != previous {
            return petname.to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_the_previous_word() {
        let mut draws = [0, 0, 1].into_iter();
        let first = generate(|| draws.next().unwrap(), "");
        let second = generate(|| draws.next().unwrap(), &first);
        assert_ne!(first, second);
    }
}
