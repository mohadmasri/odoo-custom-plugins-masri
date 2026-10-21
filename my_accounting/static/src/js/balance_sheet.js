/** @odoo-module **/

import { Component, onWillStart, onWillUpdateProps, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { openRecord } from "./open_record";
import { usePrintPageSize } from "./print_page_size";

const KINDS = [
    { value: "balance", label: "الميزانية" },
    { value: "result", label: "نتيجة السنة" },
];

const SIDES = [
    { value: "debit", label: "مدين" },
    { value: "credit", label: "دائن" },
];

const PLACEMENTS = [
    { value: "group", label: "تحت باب" },
    { value: "side", label: "آخر جانب" },
    { value: "bottom", label: "جدول المؤشرات" },
];

const LINE_SIDES = [
    { value: "debit", label: "جانب الأصول" },
    { value: "credit", label: "جانب الخصوم" },
];

const TERM_RE = /^\s*([+-]?)\s*(\[[^\]]*\]|\{[^}]*\}|<[^>]*>)\s*/;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function same(first, second) {
    return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * خانة في معادلة: يُكتب فيها اسم الحساب أو الباب أو البند، فتنزل قائمة
 * بما يطابقه ويُختار منها. الاسم هو المعروض، والرمز يبقى خلفه.
 */
export class RefPicker extends Component {
    static template = "my_accounting.RefPicker";
    static props = ["*"];

    setup() {
        this.state = useState({ text: this.labelOf(this.props.value), open: false, active: 0 });
        this.root = useRef("root");
        onWillUpdateProps((next) => {
            if (next.value !== this.props.value) {
                this.state.text = this.labelOf(next.value, next.options);
            }
        });
    }

    labelOf(token, options) {
        const found = (options || this.props.options || []).find(
            (item) => item.token === token);
        return found ? found.display : "";
    }

    get matches() {
        const text = this.state.text.trim();
        const options = this.props.options || [];
        if (!text) {
            return options.slice(0, 50);
        }
        return options
            .filter((item) => item.display.includes(text) || `${item.hint}`.includes(text))
            .slice(0, 50);
    }

    onInput(ev) {
        this.state.text = ev.target.value;
        this.state.open = true;
        this.state.active = 0;
    }

    onFocus() {
        this.state.open = true;
    }

    onBlur() {
        // النقر على خيار يقع بعد الخروج من الحقل، فنمهله
        setTimeout(() => {
            if (this.root.el && this.root.el.contains(document.activeElement)) {
                return;
            }
            this.state.open = false;
            this.state.text = this.labelOf(this.props.value);
        }, 180);
    }

    onKeydown(ev) {
        const matches = this.matches;
        if (ev.key === "ArrowDown") {
            ev.preventDefault();
            this.state.open = true;
            this.state.active = Math.min(this.state.active + 1, matches.length - 1);
        } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            this.state.active = Math.max(this.state.active - 1, 0);
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            if (matches[this.state.active]) {
                this.choose(matches[this.state.active]);
            }
        } else if (ev.key === "Escape") {
            this.state.open = false;
        }
    }

    choose(option) {
        this.state.text = option.display;
        this.state.open = false;
        this.props.onSelect(option.token);
    }

    isActive(index) {
        return index === this.state.active;
    }
}

/**
 * الميزانية السنوية: الأصول في جانب، والخصوم وحقوق الملكية ونتيجة السنة
 * في الآخر. وإعداداتها — الأبواب وتصنيف الحسابات والبنود المحسوبة —
 * تُحرَّر على مسوّدة ولا تُحفظ إلا بزرّ الحفظ.
 */
export class BalanceSheet extends Component {
    static template = "my_accounting.BalanceSheet";
    static components = { RefPicker };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.printPage = usePrintPageSize("A4 portrait", "8mm");
        this.kinds = KINDS;
        this.sides = SIDES;
        this.placements = PLACEMENTS;
        this.lineSides = LINE_SIDES;
        this.saved = { groups: [], accounts: [], lines: [] };
        this.state = useState({
            loading: true,
            data: null,
            year: "",
            tab: "sheet",
            panel: "groups",
            groups: [],
            accounts: [],
            lines: [],
            references: [],
            showEmpty: false,
            busy: false,
            accountSearch: "",
        });
        onWillStart(async () => {
            await this.load();
            await this.loadSettings();
        });
    }

    async load() {
        this.state.loading = true;
        try {
            const data = await this.orm.call("myaccounting.account", "get_balance_sheet",
                [this.state.year || false, ["posted"], this.state.showEmpty]);
            this.state.data = data;
            this.state.year = `${data.year}`;
        } finally {
            this.state.loading = false;
        }
    }

    async loadSettings() {
        const [groups, accounts, lines, references] = await Promise.all([
            this.orm.call("myaccounting.statement.group", "get_groups", []),
            this.orm.call("myaccounting.account", "get_statement_accounts", []),
            this.orm.call("myaccounting.statement.line", "get_lines", []),
            this.orm.call("myaccounting.account", "get_formula_references", []),
        ]);
        this.saved = { groups: clone(groups), accounts: clone(accounts), lines: clone(lines) };
        this.state.groups = groups;
        this.state.accounts = accounts;
        this.state.lines = lines;
        this.state.references = references;
    }

    get data() {
        return this.state.data;
    }

    isYear(year) {
        return `${year}` === this.state.year;
    }

    async onYear(ev) {
        this.state.year = ev.target.value;
        await this.load();
    }

    async toggleEmpty() {
        this.state.showEmpty = !this.state.showEmpty;
        await this.load();
    }

    setTab(tab) {
        this.state.tab = tab;
    }

    setPanel(panel) {
        this.state.panel = panel;
    }

    // ------------------------------------------------------------------
    // الحفظ والإلغاء: لوحة واحدة في كل مرة
    // ------------------------------------------------------------------

    isDirty(panel) {
        return !same(this.state[panel], this.saved[panel]);
    }

    get dirtyPanel() {
        return this.isDirty(this.state.panel);
    }

    async save() {
        const panel = this.state.panel;
        const calls = {
            groups: ["myaccounting.statement.group", "save_groups"],
            accounts: ["myaccounting.account", "save_statement_accounts"],
            lines: ["myaccounting.statement.line", "save_lines"],
        };
        const [model, method] = calls[panel];
        this.state.busy = true;
        try {
            const items = panel === "accounts"
                ? this.state.accounts.map((account) => ({
                    id: account.id, group_id: account.group_id, opening: account.opening,
                }))
                : clone(this.state[panel]);
            await this.orm.call(model, method, [items]);
            await this.loadSettings();
            await this.load();
            this.notification.add("حُفظ.", { type: "success" });
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر الحفظ.", { type: "danger" });
        } finally {
            this.state.busy = false;
        }
    }

    cancel() {
        this.state[this.state.panel] = clone(this.saved[this.state.panel]);
    }

    // ------------------------------------------------------------------
    // الأبواب
    // ------------------------------------------------------------------

    isValue(value, expected) {
        return value === expected;
    }

    editGroup(group, field, ev) {
        group[field] = field === "sequence"
            ? parseInt(ev.target.value, 10) || 0
            : ev.target.value;
    }

    addGroup() {
        this.state.groups.push({
            id: false, name: "باب جديد", kind: "balance", side: "debit",
            sequence: 10 * (this.state.groups.length + 1), accounts: 0,
        });
    }

    removeGroup(index) {
        this.state.groups.splice(index, 1);
    }

    // ------------------------------------------------------------------
    // تصنيف الحسابات والرصيد الافتتاحي
    // ------------------------------------------------------------------

    get visibleAccounts() {
        const text = this.state.accountSearch.trim();
        if (!text) {
            return this.state.accounts;
        }
        return this.state.accounts.filter(
            (account) => `${account.code} ${account.name}`.includes(text));
    }

    onAccountSearch(ev) {
        this.state.accountSearch = ev.target.value;
    }

    editAccountGroup(account, ev) {
        account.group_id = ev.target.value ? parseInt(ev.target.value, 10) : false;
    }

    editOpening(account, ev) {
        account.opening = parseFloat(ev.target.value) || 0;
    }

    isAccountGroup(account, groupId) {
        return (account.group_id || false) === (groupId || false);
    }

    indent(level) {
        return `padding-inline-start:${8 + (level || 0) * 16}px;`;
    }

    // ------------------------------------------------------------------
    // البنود المحسوبة
    // ------------------------------------------------------------------

    editLine(line, field, ev) {
        if (field === "sequence") {
            line.sequence = parseInt(ev.target.value, 10) || 0;
        } else if (field === "bold") {
            line.bold = ev.target.checked;
        } else if (field === "group_id") {
            line.group_id = ev.target.value ? parseInt(ev.target.value, 10) : false;
        } else {
            line[field] = ev.target.value;
        }
    }

    addLine() {
        this.state.lines.push({
            id: false, name: "بند جديد", formula: "", sequence: 50,
            placement: "bottom", group_id: false, side: "debit", bold: false,
            terms: [{ op: "+", token: "" }],
        });
    }

    removeLine(index) {
        this.state.lines.splice(index, 1);
    }

    /** خانات المعادلة، أو null إن كانت أعقد من سلسلة جمع وطرح */
    parseTerms(formula) {
        const text = `${formula || ""}`.trim();
        if (!text) {
            return [];
        }
        const terms = [];
        let rest = text;
        while (rest.length) {
            const match = TERM_RE.exec(rest);
            if (!match) {
                return null;
            }
            terms.push({ op: match[1] === "-" ? "-" : "+", token: match[2] });
            rest = rest.slice(match[0].length);
        }
        return terms;
    }

    terms(line) {
        if (!line.terms) {
            line.terms = this.parseTerms(line.formula) || [];
        }
        return line.terms;
    }

    isAdvanced(line) {
        return this.parseTerms(line.formula) === null;
    }

    syncFormula(line) {
        line.formula = line.terms
            .filter((term) => term.token)
            .map((term, index) => (
                index === 0
                    ? (term.op === "-" ? `- ${term.token}` : term.token)
                    : ` ${term.op} ${term.token}`
            ))
            .join("");
    }

    onTermSign(line, index, ev) {
        this.terms(line)[index].op = ev.target.value;
        this.syncFormula(line);
    }

    onTermRef(line, index, token) {
        this.terms(line)[index].token = token;
        this.syncFormula(line);
    }

    addTerm(line) {
        this.terms(line).push({ op: "+", token: "" });
    }

    removeTerm(line, index) {
        this.terms(line).splice(index, 1);
        this.syncFormula(line);
    }

    /** خطأ البند كما حسبه الخادم، ليظهر بجانب معادلته */
    lineError(line) {
        if (!this.data || !line.id) {
            return "";
        }
        const all = [
            ...this.data.bottom_formulas,
            ...this.data.left_formulas,
            ...this.data.right_formulas,
        ];
        for (const section of [...this.data.left, ...this.data.right]) {
            all.push(...(section.formulas || []));
        }
        const found = all.find((item) => item.id === line.id);
        return found ? found.error : "";
    }

    isPlacement(line, value) {
        return (line.placement || "") === value;
    }

    isLineGroup(line, groupId) {
        return (line.group_id || false) === (groupId || false);
    }

    isLineSide(line, value) {
        return (line.side || "debit") === value;
    }

    // ------------------------------------------------------------------

    openAccount(accountId, isMiddleClick) {
        openRecord(this.actionService, "myaccounting.account", accountId, isMiddleClick);
    }

    fmt(value) {
        let number = Number(value) || 0;
        if (Math.abs(number) < 0.0005) {
            number = 0;
        }
        return number.toLocaleString("en-US", {
            minimumFractionDigits: 3, maximumFractionDigits: 3,
        });
    }

    print() {
        this.printPage.enable();
        window.print();
    }
}

registry.category("actions").add("my_accounting.balance_sheet", BalanceSheet);
