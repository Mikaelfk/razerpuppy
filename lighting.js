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

// Chroma is a whole-device interface on the Naga V2 Pro. Preserve the logo
// around those writes; serialize all writes so a logo edit cannot race a restore.
export class LightingController {
    constructor(call) {
        this._call = call;
        this._pending = new Map();
    }

    write(serial, zones, zone, iface, method, signature, values) {
        const previous = this._pending.get(serial) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(() =>
            this._write(serial, zones, zone, iface, method, signature, values));
        this._pending.set(serial, next);
        return next;
    }

    async _write(serial, zones, zone, iface, method, signature, values) {
        const logo = zones.find(item => item.prefix === 'Logo');
        const call = (target, name, sig = null, args = []) => this._call(serial, target, name, sig, args);
        const restore = [];
        if (!zone.prefix && logo) {
            const read = async name => {
                const reply = await call(logo.interface, name);
                return reply.recursiveUnpack()[0];
            };
            // Read everything before writing anything. Missing getters must never
            // result in a whole-device write that silently overwrites the logo.
            if (iface === zone.interface) {
                const effect = await read('getLogoEffect');
                let saved = logo.effects.find(item => item.suffix.toLowerCase() === effect.toLowerCase());
                if (effect === 'wave') saved = {method: 'setLogoWave', colors: 0};
                if (!saved) throw new Error(`Cannot preserve logo effect: ${effect}`);
                let args = [];
                if (saved.colors) {
                    const colors = await read('getLogoEffectColors');
                    if (colors.length < saved.colors * 3) throw new Error('Cannot read logo colors');
                    args = colors.slice(0, saved.colors * 3);
                }
                if (effect === 'reactive') args.push(await read('getLogoEffectSpeed'));
                if (effect === 'wave') args.push(await read('getLogoWaveDir'));
                restore.push([logo.interface, saved.method, args.length ? `(${'y'.repeat(args.length)})` : null, args]);
            }
            if (logo.brightness) {
                const brightness = await read('getLogoBrightness');
                restore.push([logo.brightness.interface, logo.brightness.method, '(d)', [brightness]]);
            }
            if (!restore.length) throw new Error('Cannot preserve logo lighting');
        }
        let writeError;
        try { await call(iface, method, signature, values); }
        catch (error) { writeError = error; }
        // Even a failed command may have changed hardware before returning an error.
        let restoreError;
        await restore.reduce((pending, args) => pending.then(() => call(...args))
            .catch(error => { restoreError = error; }), Promise.resolve());
        if (restoreError) throw new Error(`Unable to restore logo lighting: ${restoreError.message}`);
        if (writeError) throw writeError;
    }
}
