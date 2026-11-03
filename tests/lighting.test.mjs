import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const {discoverLighting, effectArguments} = await load(readFileSync(new URL('../lighting.js', import.meta.url), 'utf8'));
const node = interfaces => ({lookup_interface: name => interfaces[name]
    ? {lookup_method: method => interfaces[name].includes(method) ? {} : null} : null});
const naga = node({
    'razer.device.lighting.logo': ['getLogoBrightness', 'setLogoBrightness', 'setLogoStatic', 'setLogoNone', 'setLogoSpectrum'],
    'razer.device.lighting.chroma': ['setStatic', 'setNone', 'setBreathDual', 'setReactive'],
});

test('Naga V2 Pro exposes both zones without effect getters or thumb-grid brightness', () => {
    const zones = discoverLighting(naga);
    assert.equal(zones.length, 2);
    assert.deepEqual(zones[0].effects.map(e => e.method), ['setLogoNone', 'setLogoStatic', 'setLogoSpectrum']);
    assert.equal(zones[0].brightness.method, 'setLogoBrightness');
    assert.deepEqual(zones[1].effects.map(e => e.method), ['setNone', 'setStatic', 'setBreathDual', 'setReactive']);
    assert.equal(zones[1].brightness, null);
});

test('devices without lighting (including Naga V2 HyperSpeed) expose no controls', () => {
    assert.deepEqual(discoverLighting(node({})), []);
});

test('legacy logo devices and optional Chroma brightness use their own interfaces', () => {
    const zones = discoverLighting(node({
        'razer.device.lighting.logo': ['getLogoEffect', 'setLogoStatic'],
        'razer.device.lighting.chroma': ['setStatic'],
        'razer.device.lighting.brightness': ['setBrightness'],
    }));
    assert.equal(zones[0].effects[0].method, 'setLogoStatic');
    assert.equal(zones[1].brightness.interface, 'razer.device.lighting.brightness');
});

test('effect arguments match OpenRazer byte signatures and reactive speed range', () => {
    const color = {red: 0.5, green: 1, blue: 0};
    const effects = discoverLighting(naga)[1].effects;
    assert.deepEqual(effectArguments(effects[0], color, color), {signature: null, values: []});
    assert.deepEqual(effectArguments(effects[1], color, color), {signature: '(yyy)', values: [128, 255, 0]});
    assert.deepEqual(effectArguments(effects[2], color, color), {signature: '(yyyyyy)', values: [128, 255, 0, 128, 255, 0]});
    assert.deepEqual(effectArguments(effects[3], color, color), {signature: '(yyyy)', values: [128, 255, 0, 2]});
});

test('D-Bus writes route to the chosen serial and zone and report failures', async () => {
    const calls = [];
    let failure = false;
    const proxy = {
        call(...args) { calls.push(args.slice(0, 2)); args.at(-1)(proxy, {}); },
        call_finish() { if (failure) throw new Error('Device disconnected'); return {}; },
    };
    globalThis.lightingTestGio = {
        BusType: {SESSION: 0}, DBusProxyFlags: {NONE: 0}, DBusCallFlags: {NONE: 0},
        DBusProxy: {
            new_for_bus(...args) { calls.push(args.slice(3, 6)); args.at(-1)(null, {}); },
            new_for_bus_finish() { return proxy; },
        },
    };
    globalThis.lightingTestGLib = {Variant: class {constructor(signature, values) {this.signature = signature; this.values = values;}}};
    const source = readFileSync(new URL('../razerdbushandler.js', import.meta.url), 'utf8')
        .replace("import Gio from 'gi://Gio';", 'const Gio = globalThis.lightingTestGio;')
        .replace("import GLib from 'gi://GLib';", 'const GLib = globalThis.lightingTestGLib;');
    const {RazerDbusHandler} = await load(source);
    const handler = new RazerDbusHandler();
    await handler.CallLighting('serial123', 'razer.device.lighting.chroma', 'setStatic', '(yyy)', [1, 2, 3]);
    assert.deepEqual(calls[0], ['org.razer', '/org/razer/device/serial123', 'razer.device.lighting.chroma']);
    assert.equal(calls[1][0], 'setStatic');
    assert.equal(calls[1][1].signature, '(yyy)');
    assert.deepEqual(calls[1][1].values, [1, 2, 3]);
    failure = true;
    await assert.rejects(handler.CallLighting('serial123', 'razer.device.lighting.logo', 'setLogoNone', null, []), /Device disconnected/);
    delete globalThis.lightingTestGio;
    delete globalThis.lightingTestGLib;
});
