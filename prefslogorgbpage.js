import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import * as Constants from './constants.js';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {RazerDbusHandler} from './razerdbushandler.js';
import {effectArguments, LightingController} from './lighting.js';

export class LogoRgbPageHandler {
    constructor(prefs) {
        this._prefs = prefs;
        this._dbus = new RazerDbusHandler();
        this._lighting = new LightingController(this._dbus.CallLighting.bind(this._dbus));
    }

    createPage() {
        this._page = new Adw.PreferencesPage({title: _('Lighting'), icon_name: Constants.ICON_LOGO_RGB});
        this._prefs._window.add(this._page);
        this._empty = new Adw.PreferencesGroup({title: _('No supported lighting devices detected')});
        this._page.add(this._empty);
    }

    onDeviceName(device) {
        for (const zone of device._lightingZones ?? []) this._addZone(device, zone);
    }

    _addZone(device, zone) {
        this._empty.hide();
        const group = new Adw.PreferencesGroup({title: `${device._device_name} — ${_(zone.label)}`,
            description: _('Choose an effect and apply it to this lighting zone.')});
        this._page.add(group);
        const effects = Gtk.DropDown.new_from_strings(zone.effects.map(effect => _(effect.label)));
        group.add(effects);
        const colors = [0, 1].map(() => {
            const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog()});
            button.set_rgba(new Gdk.RGBA({red: 1, green: 1, blue: 1, alpha: 1}));
            group.add(button);
            return button;
        });
        const updateColors = () => {
            const effect = zone.effects[effects.get_selected()];
            colors.forEach((button, index) => button.set_visible(index < effect.colors));
        };
        effects.connect('notify::selected', updateColors);
        updateColors();
        const status = new Gtk.Label({wrap: true});
        const apply = new Gtk.Button({label: _('Apply effect'), halign: Gtk.Align.START});
        group.add(apply);
        const write = async (button, iface, method, signature, values) => {
            button.set_sensitive(false);
            status.set_text('');
            try {
                await this._lighting.write(device._device_serial, device._lightingZones, zone,
                    iface, method, signature, values);
                status.set_text(_('Applied'));
            } catch (error) {
                status.set_text(`${_('Unable to apply lighting')}: ${error.message}`);
            } finally {
                button.set_sensitive(true);
            }
        };
        apply.connect('clicked', () => {
            const effect = zone.effects[effects.get_selected()];
            const args = effectArguments(effect, colors[0].get_rgba(), colors[1].get_rgba());
            void write(apply, zone.interface, effect.method, args.signature, args.values);
        });
        if (zone.brightness) {
            group.add(new Gtk.Label({label: _('Brightness')}));
            const brightness = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1);
            brightness.set_value(50);
            group.add(brightness);
            const setBrightness = new Gtk.Button({label: _('Apply brightness'), halign: Gtk.Align.START});
            group.add(setBrightness);
            setBrightness.connect('clicked', () => {
                void write(setBrightness, zone.brightness.interface, zone.brightness.method,
                    '(d)', [brightness.get_value()]);
            });
        }
        group.add(status);
    }
}
