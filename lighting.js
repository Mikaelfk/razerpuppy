// OpenRazer lighting capabilities, independent of device names and USB transport.
export const EFFECTS = [
    {label: 'Off', suffix: 'None', colors: 0},
    {label: 'Static', suffix: 'Static', colors: 1},
    {label: 'Breathe Single', suffix: 'BreathSingle', colors: 1},
    {label: 'Breathe Dual', suffix: 'BreathDual', colors: 2},
    {label: 'Breathe Random', suffix: 'BreathRandom', colors: 0},
    {label: 'Spectrum', suffix: 'Spectrum', colors: 0},
    {label: 'Reactive', suffix: 'Reactive', colors: 1},
];

export function discoverLighting(node) {
    return [
        {label: 'Logo', interface: 'razer.device.lighting.logo', prefix: 'Logo'},
        {label: 'Thumb grid / Chroma', interface: 'razer.device.lighting.chroma', prefix: ''},
    ].flatMap(zone => {
        const iface = node.lookup_interface(zone.interface);
        if (!iface) return [];
        const effects = EFFECTS.map(effect => ({
            ...effect, method: `set${zone.prefix}${effect.suffix}`,
        })).filter(effect => iface.lookup_method(effect.method));
        if (!effects.length) return [];
        const brightnessInterface = zone.prefix ? iface : node.lookup_interface('razer.device.lighting.brightness');
        const brightnessMethod = `set${zone.prefix}Brightness`;
        return [{...zone, effects, brightness: brightnessInterface?.lookup_method(brightnessMethod)
            ? {interface: zone.prefix ? zone.interface : 'razer.device.lighting.brightness', method: brightnessMethod}
            : null}];
    });
}

export function effectArguments(effect, color1, color2, speed = 2) {
    const byte = value => Math.max(0, Math.min(255, Math.round(value * 255)));
    const colors = [color1, color2].slice(0, effect.colors)
        .flatMap(color => [color.red, color.green, color.blue].map(byte));
    if (effect.suffix === 'Reactive') colors.push(Math.max(1, Math.min(4, Math.round(speed))));
    return {signature: colors.length ? `(${'y'.repeat(colors.length)})` : null, values: colors};
}
