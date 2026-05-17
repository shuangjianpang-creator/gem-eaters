// Pure data: themes, mode list, random-default pickers, color palette.

export const RANDOM_NAMES = [
    'Slither', 'Hisser', 'Coil', 'Fang', 'Viper', 'Nibble', 'Wiggle', 'Zigzag',
    'Boop', 'Dart', 'Scaly', 'Loop', 'Glide', 'Snappy', 'Twirl', 'Spike',
];
export const RANDOM_AVATARS = ['🐍','🐉','🦊','🐺','🦄','🐙','🦖','👾','🔥','⚡','🐲','🦅'];
export const RANDOM_COLORS  = ['#56d364','#f0883e','#a371f7','#58a6ff','#f85149','#d29922','#ec4899','#06b6d4','#facc15','#34d399','#fb7185','#a3e635'];

export const COLOR_PALETTE = RANDOM_COLORS.slice();

export const MODES_LIST = [
    { id: 'ffa',      name: 'Free for All',        icon: '⚔️', description: 'Eat food, eat rivals. Highest score wins.' },
    { id: 'lastman',  name: 'Last Snake Standing', icon: '💀', description: 'One death and you\'re out. Last alive wins.' },
    { id: 'teams',    name: 'Teams (Red vs Blue)', icon: '🚩', description: 'Auto-assigned. No friendly fire. Team score totals.' },
    { id: 'koth',     name: 'King of the Hill',    icon: '👑', description: 'Stay in the gold ring to earn points. Highest score wins.' },
    { id: 'tag',      name: 'Tag — you\'re it!',  icon: '👹', description: 'Collisions pass the "it" status. Score = time NOT being it.' },
    { id: 'potato',   name: 'Hot Potato',          icon: '💣', description: '12s bomb on a random snake. Touch someone to pass it. Don\'t hold it when it blows.' },
    { id: 'goldrush', name: 'Gold Rush',           icon: '🪙', description: 'No power-ups. Rare gold coins worth +5. Fight for every drop.' },
    { id: 'boss',     name: 'Boss Snake',          icon: '🐲', description: 'A huge AI boss hunts the room. Cooperate — make it crash into your body to take it down.' },
];

export const THEMES = {
    grasslands: {
        base: "#2c4a2c", patchDark: "#26412a", patchLight: "#365a37", patchBright: "#3f6b40",
        bladeDark: "#234722", bladeLight: "#4d7a4a",
        clumpShadow: "rgba(0,0,0,0.18)", clumpDark: "#1f3e1e", clumpLight: "#5b8e58",
        pebbleBase: 108,
    },
    desert: {
        base: "#c4a86c", patchDark: "#a08850", patchLight: "#d4b878", patchBright: "#e8cf98",
        bladeDark: "#8a6e3c", bladeLight: "#b89860",
        clumpShadow: "rgba(60,40,15,0.22)", clumpDark: "#6a4f2b", clumpLight: "#8a7045",
        pebbleBase: 150,
    },
    snow: {
        base: "#dde3eb", patchDark: "#c2cad4", patchLight: "#ecf0f5", patchBright: "#ffffff",
        bladeDark: "#9ba8b7", bladeLight: "#c5cfdb",
        clumpShadow: "rgba(70,90,120,0.18)", clumpDark: "#7a8694", clumpLight: "#a9b4c0",
        pebbleBase: 200,
    },
    lava: {
        base: "#1a0808", patchDark: "#100404", patchLight: "#2a0e0a", patchBright: "#3d1410",
        bladeDark: "#5a1a10", bladeLight: "#a02f1c",
        clumpShadow: "rgba(0,0,0,0.4)", clumpDark: "#3a0c08", clumpLight: "#9a2a18",
        pebbleBase: 60,
    },
};

export function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
