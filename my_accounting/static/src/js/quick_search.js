/** @odoo-module **/

import { Component, useExternalListener, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { openRecord } from "./open_record";

const DEBOUNCE_MS = 180;
const QUICK_LIMIT = 4;

/**
 * شريط البحث العام: يكتب المستخدم أي نص فتظهر تحته أهم النتائج من القيود
 * والحسابات والبنود، والضغط على "المزيد" أو Enter يفتح صفحة البحث كاملة.
 */
export class QuickSearch extends Component {
    static template = "my_accounting.QuickSearch";
    static props = {
        placeholder: { type: String, optional: true },
        autofocus: { type: Boolean, optional: true },
        initialQuery: { type: String, optional: true },
        onSubmit: { type: Function, optional: true },
    };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.inputRef = useRef("input");
        this.rootRef = useRef("root");
        this.state = useState({
            query: this.props.initialQuery || "",
            groups: [],
            total: 0,
            open: false,
            loading: false,
            active: -1,       // السهم لأعلى/أسفل
        });
        this.timer = null;
        // الضغط خارج الشريط يغلق القائمة
        useExternalListener(window, "mousedown", (ev) => {
            if (this.rootRef.el && !this.rootRef.el.contains(ev.target)) {
                this.state.open = false;
            }
        });
    }

    /** كل النتائج في قائمة واحدة، للتنقل بالأسهم */
    get flat() {
        const flat = [];
        for (const group of this.state.groups) {
            for (const item of group.items) {
                flat.push(item);
            }
        }
        return flat;
    }

    onInput(ev) {
        this.state.query = ev.target.value;
        this.state.active = -1;
        clearTimeout(this.timer);
        if (this.state.query.trim().length < 2) {
            this.state.groups = [];
            this.state.total = 0;
            this.state.open = false;
            return;
        }
        // مهلة قصيرة: لا نسأل الخادم مع كل حرف
        this.timer = setTimeout(() => this.fetch(), DEBOUNCE_MS);
    }

    async fetch() {
        const query = this.state.query.trim();
        this.state.loading = true;
        try {
            const data = await this.orm.call("myaccounting.search", "search_all",
                [query, QUICK_LIMIT]);
            if (this.state.query.trim() !== query) {
                return;   // تغيّر النص أثناء الانتظار
            }
            this.state.groups = data.groups;
            this.state.total = data.total;
            this.state.open = true;
        } finally {
            this.state.loading = false;
        }
    }

    onFocus() {
        if (this.state.groups.length) {
            this.state.open = true;
        }
    }

    onKeydown(ev) {
        const items = this.flat;
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            if (!items.length) {
                return;
            }
            // -1 يعني "لا شيء محدّد": Enter حينها يفتح صفحة البحث
            let next = this.state.active + (ev.key === "ArrowDown" ? 1 : -1);
            if (next >= items.length) {
                next = -1;
            } else if (next < -1) {
                next = items.length - 1;
            }
            this.state.active = next;
            this.state.open = true;
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            if (this.state.active >= 0 && items[this.state.active]) {
                this.openItem(items[this.state.active], false);
            } else {
                this.openPage();
            }
        } else if (ev.key === "Escape") {
            this.state.open = false;
        }
    }

    isActive(item) {
        return this.flat[this.state.active] === item;
    }

    openItem(item, isMiddleClick) {
        this.state.open = false;
        openRecord(this.action, item.model, item.id, isMiddleClick);
    }

    openPage() {
        const query = this.state.query.trim();
        if (!query) {
            return;
        }
        this.state.open = false;
        if (this.props.onSubmit) {
            this.props.onSubmit(query);
            return;
        }
        this.action.doAction("my_accounting.action_myaccounting_search", {
            additionalContext: { search_query: query },
        });
    }

    clear() {
        this.state.query = "";
        this.state.groups = [];
        this.state.open = false;
        if (this.inputRef.el) {
            this.inputRef.el.value = "";
            this.inputRef.el.focus();
        }
    }

    fmt(value) {
        const number = Number(value) || 0;
        return number ? number.toLocaleString("en-US", {
            minimumFractionDigits: 3, maximumFractionDigits: 3,
        }) : "";
    }
}

/**
 * صفحة البحث: نفس النتائج بلا حدّ قصير، مع شريط البحث فوقها.
 */
export class SearchPage extends Component {
    static template = "my_accounting.SearchPage";
    static components = { QuickSearch };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.state = useState({ query: "", groups: [], total: 0, loading: false });
        const context = (this.props.action && this.props.action.context) || {};
        const query = context.search_query || "";
        if (query) {
            this.state.query = query;
            this.search(query);
        }
    }

    onSubmit(query) {
        this.state.query = query;
        this.search(query);
    }

    async search(query) {
        this.state.loading = true;
        try {
            const data = await this.orm.call("myaccounting.search", "search_all", [query, 50]);
            this.state.groups = data.groups;
            this.state.total = data.total;
        } finally {
            this.state.loading = false;
        }
    }

    openItem(item, isMiddleClick) {
        openRecord(this.action, item.model, item.id, isMiddleClick);
    }

    fmt(value) {
        const number = Number(value) || 0;
        return number ? number.toLocaleString("en-US", {
            minimumFractionDigits: 3, maximumFractionDigits: 3,
        }) : "";
    }
}

registry.category("actions").add("my_accounting.search_page", SearchPage);
