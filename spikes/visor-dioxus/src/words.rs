//! THE AUDIBLE ANCHOR WORD — the anchor colour's twin for people who do not
//! see it. Ported from `visor/ui/words.ts`; that file's header is the design
//! record and is not restated here. What matters at this seam:
//!
//! The three voices are marked in PIXELS, and a screen reader has none — it
//! linearises the page, so app-frame text and visor text arrive as one
//! undifferentiated stream and an app can render, inside its own rectangle, a
//! sentence that sounds exactly like the visor speaking. The answer is a token
//! the user learns and an app cannot guess: a word rolled once per identity,
//! prefixing every drawer lifecycle sentence the host speaks.
//!
//! WHY THIS MODULE IS `pub(crate)` AND HAS NO PUBLIC ACCESSOR FOR THE
//! COMMITTED WORD. `wit/world.wit:209-215` states the structural rule: there is
//! no getter for the anchor word on `control`, and there must never be one,
//! because a word that reaches pixels is a word a screenshot or a screen-share
//! hands straight to an app. In TypeScript that is a module-private `let`
//! (visor.ts:1246). Here it is a private field on `Visor` (see `state.rs`) plus
//! this module's crate-private visibility: nothing outside the crate can name
//! the wordlist, and nothing outside `state` can read the committed value.

/// THE EFF SHORT WORDLIST 2.0 — 1296 words, verbatim and in the upstream
/// order, transcribed from `visor/ui/words.ts`.
///
/// Source: <https://www.eff.org/files/2016/09/08/eff_short_wordlist_2_0.txt>
/// Licence: CC-BY 3.0 (Electronic Frontier Foundation).
///
/// Chosen for PHONETIC DISTINCTNESS: unique three-letter prefixes, no two
/// words within edit distance 2, and none of the homophone traps that would
/// make a mis-heard token indistinguishable from a guessed one. A user who
/// learns their word by ear must be able to notice when a DIFFERENT word is
/// said.
pub(crate) static VISOR_WORDS: [&str; 1296] = [
    "aardvark", "abandoned", "abbreviate", "abdomen", "abhorrence", "abiding",
    "abnormal", "abrasion", "absorbing", "abundant", "abyss", "academy",
    "accountant", "acetone", "achiness", "acid", "acoustics", "acquire",
    "acrobat", "actress", "acuteness", "aerosol", "aesthetic", "affidavit",
    "afloat", "afraid", "aftershave", "again", "agency", "aggressor",
    "aghast", "agitate", "agnostic", "agonizing", "agreeing", "aidless",
    "aimlessly", "ajar", "alarmclock", "albatross", "alchemy", "alfalfa",
    "algae", "aliens", "alkaline", "almanac", "alongside", "alphabet",
    "already", "also", "altitude", "aluminum", "always", "amazingly",
    "ambulance", "amendment", "amiable", "ammunition", "amnesty", "amoeba",
    "amplifier", "amuser", "anagram", "anchor", "android", "anesthesia",
    "angelfish", "animal", "anklet", "announcer", "anonymous", "answer",
    "antelope", "anxiety", "anyplace", "aorta", "apartment", "apnea",
    "apostrophe", "apple", "apricot", "aquamarine", "arachnid", "arbitrate",
    "ardently", "arena", "argument", "aristocrat", "armchair", "aromatic",
    "arrowhead", "arsonist", "artichoke", "asbestos", "ascend", "aseptic",
    "ashamed", "asinine", "asleep", "asocial", "asparagus", "astronaut",
    "asymmetric", "atlas", "atmosphere", "atom", "atrocious", "attic",
    "atypical", "auctioneer", "auditorium", "augmented", "auspicious", "automobile",
    "auxiliary", "avalanche", "avenue", "aviator", "avocado", "awareness",
    "awhile", "awkward", "awning", "awoke", "axially", "azalea",
    "babbling", "backpack", "badass", "bagpipe", "bakery", "balancing",
    "bamboo", "banana", "barracuda", "basket", "bathrobe", "bazooka",
    "blade", "blender", "blimp", "blouse", "blurred", "boatyard",
    "bobcat", "body", "bogusness", "bohemian", "boiler", "bonnet",
    "boots", "borough", "bossiness", "bottle", "bouquet", "boxlike",
    "breath", "briefcase", "broom", "brushes", "bubblegum", "buckle",
    "buddhist", "buffalo", "bullfrog", "bunny", "busboy", "buzzard",
    "cabin", "cactus", "cadillac", "cafeteria", "cage", "cahoots",
    "cajoling", "cakewalk", "calculator", "camera", "canister", "capsule",
    "carrot", "cashew", "cathedral", "caucasian", "caviar", "ceasefire",
    "cedar", "celery", "cement", "census", "ceramics", "cesspool",
    "chalkboard", "cheesecake", "chimney", "chlorine", "chopsticks", "chrome",
    "chute", "cilantro", "cinnamon", "circle", "cityscape", "civilian",
    "clay", "clergyman", "clipboard", "clock", "clubhouse", "coathanger",
    "cobweb", "coconut", "codeword", "coexistent", "coffeecake", "cognitive",
    "cohabitate", "collarbone", "computer", "confetti", "copier", "cornea",
    "cosmetics", "cotton", "couch", "coverless", "coyote", "coziness",
    "crawfish", "crewmember", "crib", "croissant", "crumble", "crystal",
    "cubical", "cucumber", "cuddly", "cufflink", "cuisine", "culprit",
    "cup", "curry", "cushion", "cuticle", "cybernetic", "cyclist",
    "cylinder", "cymbal", "cynicism", "cypress", "cytoplasm", "dachshund",
    "daffodil", "dagger", "dairy", "dalmatian", "dandelion", "dartboard",
    "dastardly", "datebook", "daughter", "dawn", "daytime", "dazzler",
    "dealer", "debris", "decal", "dedicate", "deepness", "defrost",
    "degree", "dehydrator", "deliverer", "democrat", "dentist", "deodorant",
    "depot", "deranged", "desktop", "detergent", "device", "dexterity",
    "diamond", "dibs", "dictionary", "diffuser", "digit", "dilated",
    "dimple", "dinnerware", "dioxide", "diploma", "directory", "dishcloth",
    "ditto", "dividers", "dizziness", "doctor", "dodge", "doll",
    "dominoes", "donut", "doorstep", "dorsal", "double", "downstairs",
    "dozed", "drainpipe", "dresser", "driftwood", "droppings", "drum",
    "dryer", "dubiously", "duckling", "duffel", "dugout", "dumpster",
    "duplex", "durable", "dustpan", "dutiful", "duvet", "dwarfism",
    "dwelling", "dwindling", "dynamite", "dyslexia", "eagerness", "earlobe",
    "easel", "eavesdrop", "ebook", "eccentric", "echoless", "eclipse",
    "ecosystem", "ecstasy", "edged", "editor", "educator", "eelworm",
    "eerie", "effects", "eggnog", "egomaniac", "ejection", "elastic",
    "elbow", "elderly", "elephant", "elfishly", "eliminator", "elk",
    "elliptical", "elongated", "elsewhere", "elusive", "elves", "emancipate",
    "embroidery", "emcee", "emerald", "emission", "emoticon", "emperor",
    "emulate", "enactment", "enchilada", "endorphin", "energy", "enforcer",
    "engine", "enhance", "enigmatic", "enjoyably", "enlarged", "enormous",
    "enquirer", "enrollment", "ensemble", "entryway", "enunciate", "envoy",
    "enzyme", "epidemic", "equipment", "erasable", "ergonomic", "erratic",
    "eruption", "escalator", "eskimo", "esophagus", "espresso", "essay",
    "estrogen", "etching", "eternal", "ethics", "etiquette", "eucalyptus",
    "eulogy", "euphemism", "euthanize", "evacuation", "evergreen", "evidence",
    "evolution", "exam", "excerpt", "exerciser", "exfoliate", "exhale",
    "exist", "exorcist", "explode", "exquisite", "exterior", "exuberant",
    "fabric", "factory", "faded", "failsafe", "falcon", "family",
    "fanfare", "fasten", "faucet", "favorite", "feasibly", "february",
    "federal", "feedback", "feigned", "feline", "femur", "fence",
    "ferret", "festival", "fettuccine", "feudalist", "feverish", "fiberglass",
    "fictitious", "fiddle", "figurine", "fillet", "finalist", "fiscally",
    "fixture", "flashlight", "fleshiness", "flight", "florist", "flypaper",
    "foamless", "focus", "foggy", "folksong", "fondue", "footpath",
    "fossil", "fountain", "fox", "fragment", "freeway", "fridge",
    "frosting", "fruit", "fryingpan", "gadget", "gainfully", "gallstone",
    "gamekeeper", "gangway", "garlic", "gaslight", "gathering", "gauntlet",
    "gearbox", "gecko", "gem", "generator", "geographer", "gerbil",
    "gesture", "getaway", "geyser", "ghoulishly", "gibberish", "giddiness",
    "giftshop", "gigabyte", "gimmick", "giraffe", "giveaway", "gizmo",
    "glasses", "gleeful", "glisten", "glove", "glucose", "glycerin",
    "gnarly", "gnomish", "goatskin", "goggles", "goldfish", "gong",
    "gooey", "gorgeous", "gosling", "gothic", "gourmet", "governor",
    "grape", "greyhound", "grill", "groundhog", "grumbling", "guacamole",
    "guerrilla", "guitar", "gullible", "gumdrop", "gurgling", "gusto",
    "gutless", "gymnast", "gynecology", "gyration", "habitat", "hacking",
    "haggard", "haiku", "halogen", "hamburger", "handgun", "happiness",
    "hardhat", "hastily", "hatchling", "haughty", "hazelnut", "headband",
    "hedgehog", "hefty", "heinously", "helmet", "hemoglobin", "henceforth",
    "herbs", "hesitation", "hexagon", "hubcap", "huddling", "huff",
    "hugeness", "hullabaloo", "human", "hunter", "hurricane", "hushing",
    "hyacinth", "hybrid", "hydrant", "hygienist", "hypnotist", "ibuprofen",
    "icepack", "icing", "iconic", "identical", "idiocy", "idly",
    "igloo", "ignition", "iguana", "illuminate", "imaging", "imbecile",
    "imitator", "immigrant", "imprint", "iodine", "ionosphere", "ipad",
    "iphone", "iridescent", "irksome", "iron", "irrigation", "island",
    "isotope", "issueless", "italicize", "itemizer", "itinerary", "itunes",
    "ivory", "jabbering", "jackrabbit", "jaguar", "jailhouse", "jalapeno",
    "jamboree", "janitor", "jarring", "jasmine", "jaundice", "jawbreaker",
    "jaywalker", "jazz", "jealous", "jeep", "jelly", "jeopardize",
    "jersey", "jetski", "jezebel", "jiffy", "jigsaw", "jingling",
    "jobholder", "jockstrap", "jogging", "john", "joinable", "jokingly",
    "journal", "jovial", "joystick", "jubilant", "judiciary", "juggle",
    "juice", "jujitsu", "jukebox", "jumpiness", "junkyard", "juror",
    "justifying", "juvenile", "kabob", "kamikaze", "kangaroo", "karate",
    "kayak", "keepsake", "kennel", "kerosene", "ketchup", "khaki",
    "kickstand", "kilogram", "kimono", "kingdom", "kiosk", "kissing",
    "kite", "kleenex", "knapsack", "kneecap", "knickers", "koala",
    "krypton", "laboratory", "ladder", "lakefront", "lantern", "laptop",
    "laryngitis", "lasagna", "latch", "laundry", "lavender", "laxative",
    "lazybones", "lecturer", "leftover", "leggings", "leisure", "lemon",
    "length", "leopard", "leprechaun", "lettuce", "leukemia", "levers",
    "lewdness", "liability", "library", "licorice", "lifeboat", "lightbulb",
    "likewise", "lilac", "limousine", "lint", "lioness", "lipstick",
    "liquid", "listless", "litter", "liverwurst", "lizard", "llama",
    "luau", "lubricant", "lucidity", "ludicrous", "luggage", "lukewarm",
    "lullaby", "lumberjack", "lunchbox", "luridness", "luscious", "luxurious",
    "lyrics", "macaroni", "maestro", "magazine", "mahogany", "maimed",
    "majority", "makeover", "malformed", "mammal", "mango", "mapmaker",
    "marbles", "massager", "matchstick", "maverick", "maximum", "mayonnaise",
    "moaning", "mobilize", "moccasin", "modify", "moisture", "molecule",
    "momentum", "monastery", "moonshine", "mortuary", "mosquito", "motorcycle",
    "mousetrap", "movie", "mower", "mozzarella", "muckiness", "mudflow",
    "mugshot", "mule", "mummy", "mundane", "muppet", "mural",
    "mustard", "mutation", "myriad", "myspace", "myth", "nail",
    "namesake", "nanosecond", "napkin", "narrator", "nastiness", "natives",
    "nautically", "navigate", "nearest", "nebula", "nectar", "nefarious",
    "negotiator", "neither", "nemesis", "neoliberal", "nephew", "nervously",
    "nest", "netting", "neuron", "nevermore", "nextdoor", "nicotine",
    "niece", "nimbleness", "nintendo", "nirvana", "nuclear", "nugget",
    "nuisance", "nullify", "numbing", "nuptials", "nursery", "nutcracker",
    "nylon", "oasis", "oat", "obediently", "obituary", "object",
    "obliterate", "obnoxious", "observer", "obtain", "obvious", "occupation",
    "oceanic", "octopus", "ocular", "office", "oftentimes", "oiliness",
    "ointment", "older", "olympics", "omissible", "omnivorous", "oncoming",
    "onion", "onlooker", "onstage", "onward", "onyx", "oomph",
    "opaquely", "opera", "opium", "opossum", "opponent", "optical",
    "opulently", "oscillator", "osmosis", "ostrich", "otherwise", "ought",
    "outhouse", "ovation", "oven", "owlish", "oxford", "oxidize",
    "oxygen", "oyster", "ozone", "pacemaker", "padlock", "pageant",
    "pajamas", "palm", "pamphlet", "pantyhose", "paprika", "parakeet",
    "passport", "patio", "pauper", "pavement", "payphone", "pebble",
    "peculiarly", "pedometer", "pegboard", "pelican", "penguin", "peony",
    "pepperoni", "peroxide", "pesticide", "petroleum", "pewter", "pharmacy",
    "pheasant", "phonebook", "phrasing", "physician", "plank", "pledge",
    "plotted", "plug", "plywood", "pneumonia", "podiatrist", "poetic",
    "pogo", "poison", "poking", "policeman", "poncho", "popcorn",
    "porcupine", "postcard", "poultry", "powerboat", "prairie", "pretzel",
    "princess", "propeller", "prune", "pry", "pseudo", "psychopath",
    "publisher", "pucker", "pueblo", "pulley", "pumpkin", "punchbowl",
    "puppy", "purse", "pushup", "putt", "puzzle", "pyramid",
    "python", "quarters", "quesadilla", "quilt", "quote", "racoon",
    "radish", "ragweed", "railroad", "rampantly", "rancidity", "rarity",
    "raspberry", "ravishing", "rearrange", "rebuilt", "receipt", "reentry",
    "refinery", "register", "rehydrate", "reimburse", "rejoicing", "rekindle",
    "relic", "remote", "renovator", "reopen", "reporter", "request",
    "rerun", "reservoir", "retriever", "reunion", "revolver", "rewrite",
    "rhapsody", "rhetoric", "rhino", "rhubarb", "rhyme", "ribbon",
    "riches", "ridden", "rigidness", "rimmed", "riptide", "riskily",
    "ritzy", "riverboat", "roamer", "robe", "rocket", "romancer",
    "ropelike", "rotisserie", "roundtable", "royal", "rubber", "rudderless",
    "rugby", "ruined", "rulebook", "rummage", "running", "rupture",
    "rustproof", "sabotage", "sacrifice", "saddlebag", "saffron", "sainthood",
    "saltshaker", "samurai", "sandworm", "sapphire", "sardine", "sassy",
    "satchel", "sauna", "savage", "saxophone", "scarf", "scenario",
    "schoolbook", "scientist", "scooter", "scrapbook", "sculpture", "scythe",
    "secretary", "sedative", "segregator", "seismology", "selected", "semicolon",
    "senator", "septum", "sequence", "serpent", "sesame", "settler",
    "severely", "shack", "shelf", "shirt", "shovel", "shrimp",
    "shuttle", "shyness", "siamese", "sibling", "siesta", "silicon",
    "simmering", "singles", "sisterhood", "sitcom", "sixfold", "sizable",
    "skateboard", "skeleton", "skies", "skulk", "skylight", "slapping",
    "sled", "slingshot", "sloth", "slumbering", "smartphone", "smelliness",
    "smitten", "smokestack", "smudge", "snapshot", "sneezing", "sniff",
    "snowsuit", "snugness", "speakers", "sphinx", "spider", "splashing",
    "sponge", "sprout", "spur", "spyglass", "squirrel", "statue",
    "steamboat", "stingray", "stopwatch", "strawberry", "student", "stylus",
    "suave", "subway", "suction", "suds", "suffocate", "sugar",
    "suitcase", "sulphur", "superstore", "surfer", "sushi", "swan",
    "sweatshirt", "swimwear", "sword", "sycamore", "syllable", "symphony",
    "synagogue", "syringes", "systemize", "tablespoon", "taco", "tadpole",
    "taekwondo", "tagalong", "takeout", "tallness", "tamale", "tanned",
    "tapestry", "tarantula", "tastebud", "tattoo", "tavern", "thaw",
    "theater", "thimble", "thorn", "throat", "thumb", "thwarting",
    "tiara", "tidbit", "tiebreaker", "tiger", "timid", "tinsel",
    "tiptoeing", "tirade", "tissue", "tractor", "tree", "tripod",
    "trousers", "trucks", "tryout", "tubeless", "tuesday", "tugboat",
    "tulip", "tumbleweed", "tupperware", "turtle", "tusk", "tutorial",
    "tuxedo", "tweezers", "twins", "tyrannical", "ultrasound", "umbrella",
    "umpire", "unarmored", "unbuttoned", "uncle", "underwear", "unevenness",
    "unflavored", "ungloved", "unhinge", "unicycle", "unjustly", "unknown",
    "unlocking", "unmarked", "unnoticed", "unopened", "unpaved", "unquenched",
    "unroll", "unscrewing", "untied", "unusual", "unveiled", "unwrinkled",
    "unyielding", "unzip", "upbeat", "upcountry", "update", "upfront",
    "upgrade", "upholstery", "upkeep", "upload", "uppercut", "upright",
    "upstairs", "uptown", "upwind", "uranium", "urban", "urchin",
    "urethane", "urgent", "urologist", "username", "usher", "utensil",
    "utility", "utmost", "utopia", "utterance", "vacuum", "vagrancy",
    "valuables", "vanquished", "vaporizer", "varied", "vaseline", "vegetable",
    "vehicle", "velcro", "vendor", "vertebrae", "vestibule", "veteran",
    "vexingly", "vicinity", "videogame", "viewfinder", "vigilante", "village",
    "vinegar", "violin", "viperfish", "virus", "visor", "vitamins",
    "vivacious", "vixen", "vocalist", "vogue", "voicemail", "volleyball",
    "voucher", "voyage", "vulnerable", "waffle", "wagon", "wakeup",
    "walrus", "wanderer", "wasp", "water", "waving", "wheat",
    "whisper", "wholesaler", "wick", "widow", "wielder", "wifeless",
    "wikipedia", "wildcat", "windmill", "wipeout", "wired", "wishbone",
    "wizardry", "wobbliness", "wolverine", "womb", "woolworker", "workbasket",
    "wound", "wrangle", "wreckage", "wristwatch", "wrongdoing", "xerox",
    "xylophone", "yacht", "yahoo", "yard", "yearbook", "yesterday",
    "yiddish", "yield", "yo-yo", "yodel", "yogurt", "yuppie",
    "zealot", "zebra", "zeppelin", "zestfully", "zigzagged", "zillion",
    "zipping", "zirconium", "zodiac", "zombie", "zookeeper", "zucchini",];

/// WORDS THE VISOR ALREADY SAYS, and therefore words it must never be ABLE to
/// roll.
///
/// The anchor word works by being the token that does NOT belong to the
/// sentence around it — "walrus: storage picker open" is legible because
/// "walrus" is arbitrary and the rest is vocabulary. Roll a word that IS part
/// of the vocabulary and the seam disappears: "device: this device back" reads
/// as a stutter, and an app that guesses the visor says "device" or "visor"
/// would be guessing the anchor itself. The EFF list really does contain
/// `visor`, `device` and `anchor` — this is not hypothetical.
///
/// Deliberately broader than what the list contains today: it names the
/// visor's spoken vocabulary, so a future upstream revision cannot quietly
/// reintroduce a collision. Entries that match nothing are free.
pub(crate) static VISOR_WORD_DENYLIST: [&str; 15] = [
    "open",
    "closed",
    "back",
    "restore",
    "visor",
    "device",
    "anchor",
    "settings",
    "storage",
    "credentials",
    "identity",
    "word",
    "name",
    "colour",
    "color",];

/// The list the roll actually draws from: the EFF list MINUS the visor's own
/// vocabulary. Also what [`is_rollable`] validates a PERSISTED value against,
/// so a word stored by an older build (or by a hand-edited storage entry) that
/// has since become vocabulary is re-rolled rather than kept.
///
/// Computed per call rather than cached: it is 1296 pointer comparisons
/// against a 15-entry list, run at most twice in the life of an instance (the
/// boot load and a re-roll), and a cached `Vec` in a thread-local would be
/// more machinery than the work it saves.
fn rollable() -> Vec<&'static str> {
    VISOR_WORDS
        .iter()
        .copied()
        .filter(|w| !VISOR_WORD_DENYLIST.contains(w))
        .collect()
}

/// Is this a word the visor may currently be answering to?
///
/// MEMBERSHIP-VALIDATED, not merely non-empty (words.ts's `loadVisorWord`):
/// the value is spoken in the visor's own voice as the token that proves the
/// voice, so anything that did not come out of this list — a stale word, a
/// hand-written storage entry, a truncated read — is treated as no word at all
/// and re-rolled.
pub(crate) fn is_rollable(word: &str) -> bool {
    VISOR_WORDS.contains(&word) && !VISOR_WORD_DENYLIST.contains(&word)
}

/// Roll a word that is not `avoid`.
///
/// Shared by the first roll and by the re-roll, whose whole contract is "a
/// DIFFERENT word": a user who asks for a new one and hears the same one has
/// been told the control does nothing (`control.reroll-word`,
/// wit/world.wit:215).
///
/// The loop terminates trivially — 1293 candidates against one excluded value
/// — and re-rolling is the honest way to say "uniform over everything but
/// that", rather than an index shuffle that is harder to read than the
/// property it implements. Ported from words.ts's `rollVisorWord`.
pub(crate) fn roll(avoid: Option<&str>) -> String {
    let pool = rollable();
    loop {
        let w = pool[crate::rng::below(pool.len())];
        if Some(w) != avoid {
            return w.to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The transcription is only worth anything if it is the upstream list:
    /// the count, the endpoints and the absence of duplicates are what a
    /// hand-edit or a truncated paste would break.
    #[test]
    fn wordlist_is_the_upstream_list() {
        assert_eq!(VISOR_WORDS.len(), 1296);
        assert_eq!(VISOR_WORDS[0], "aardvark");
        assert_eq!(VISOR_WORDS[1295], "zucchini");
        let mut seen: Vec<&str> = VISOR_WORDS.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), 1296, "the EFF list has no duplicates");
    }

    /// The denylist is not decoration: `visor`, `device` and `anchor` really
    /// are in the upstream list, and rolling one would put the anchor token
    /// inside the sentence it is supposed to stand outside of.
    #[test]
    fn the_visors_own_vocabulary_is_unrollable() {
        for w in ["visor", "device", "anchor", "storage", "open", "back"] {
            assert!(!is_rollable(w), "{w} must never be rollable");
        }
        assert_eq!(rollable().len(), 1296 - 3, "visor/device/anchor are the three that collide");
    }

    /// `reroll-word`'s whole contract (wit/world.wit:215).
    #[test]
    fn a_reroll_is_a_different_word() {
        let first = roll(None);
        for _ in 0..200 {
            assert_ne!(roll(Some(&first)), first);
        }
    }

    /// A rolled word must survive its own validation, or every boot after the
    /// first would re-roll and the user would learn that the anchor drifts.
    #[test]
    fn a_rolled_word_validates() {
        for _ in 0..200 {
            assert!(is_rollable(&roll(None)));
        }
    }
}
