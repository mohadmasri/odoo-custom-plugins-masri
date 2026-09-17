/** @odoo-module **/

import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { browser } from "@web/core/browser/browser";

const COOKIE_NAME = "color_scheme";

function isDarkScheme() {
    return document.cookie
        .split(";")
        .map((c) => c.trim())
        .some((c) => c === `${COOKIE_NAME}=dark`);
}

// زر تبديل الوضع الداكن/الفاتح في الشريط العلوي.
//
// الخادم يقرأ كوكي "color_scheme" عند تحميل الصفحة (models/ir_http.py) ليقرر
// أي حزمة أنماط يُرسل: الفاتحة (web.assets_web) أم الداكنة
// (web.assets_web_dark) المُعاد تجميعها بالألوان الداكنة. لذلك يلزم إعادة
// تحميل الصفحة بعد كل تبديل.
export class DarkModeToggle extends Component {
    static template = "my_accounting.DarkModeToggle";
    static props = {};

    setup() {
        this.state = useState({ isDark: isDarkScheme() });
    }

    toggle() {
        const next = this.state.isDark ? "light" : "dark";
        document.cookie = `${COOKIE_NAME}=${next}; path=/; max-age=${60 * 60 * 24 * 365}`;
        browser.location.reload();
    }
}

registry.category("systray").add(
    "my_accounting.dark_mode_toggle",
    { Component: DarkModeToggle },
    { sequence: 26 }
);
