/** @odoo-module **/

import { Component, onWillStart, useState } from "@odoo/owl";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
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

/**
 * الميزانية السنوية: أرصدة الحسابات موزّعة على أبواب يعرّفها المستخدم،
 * مع الرصيد الافتتاحي لكل حساب.
 */
export class BalanceSheet extends Component {
    static template = "my_accounting.BalanceSheet";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialog = useService("dialog");
        this.notification = useService("notification");
        this.printPage = usePrintPageSize("A4 portrait", "8mm");
        this.kinds = KINDS;
        this.sides = SIDES;
        this.placements = PLACEMENTS;
        this.lineSides = LINE_SIDES;
        this.state = useState({
            loading: true,
            data: null,
            year: "",
            tab: "sheet",       // sheet أو settings
            panel: "groups",    // groups أو accounts أو lines
            groups: [],
            accounts: [],
            lines: [],
            references: null,
            showEmpty: false,
            busy: false,
            accountSearch: "",
            draftTerms: {},
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
        this.state.groups = groups;
        this.state.accounts = accounts;
        this.state.lines = lines;
        this.state.references = references;
    }

    setTab(tab) {
        this.state.tab = tab;
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

    setPanel(panel) {
        this.state.panel = panel;
    }

    // ------------------------------------------------------------------
    // البنود المحسوبة
    // ------------------------------------------------------------------

    async saveLine(line, field, ev) {
        let value = ev.target.value;
        if (field === "sequence") {
            value = parseInt(value, 10) || 0;
        } else if (field === "bold") {
            value = ev.target.checked;
        } else if (field === "group_id") {
            value = value ? parseInt(value, 10) : false;
        }
        await this.withBusy(async () => {
            this.state.lines = await this.orm.call(
                "myaccounting.statement.line", "save_line", [line.id, { [field]: value }]);
            await this.load();
        });
    }

    async addLine() {
        await this.withBusy(async () => {
            this.state.lines = await this.orm.call(
                "myaccounting.statement.line", "save_line",
                [false, { name: "بند جديد", formula: "0", placement: "bottom", sequence: 50 }]);
            await this.load();
        });
    }

    deleteLine(line) {
        this.dialog.add(ConfirmationDialog, {
            title: `حذف "${line.name}"`,
            body: "سيُحذف البند من الميزانية.",
            confirmLabel: "احذف",
            confirm: () => this.withBusy(async () => {
                this.state.lines = await this.orm.call(
                    "myaccounting.statement.line", "delete_line", [line.id]);
                await this.load();
            }),
            cancel: () => {},
        });
    }

    // ------------------------------------------------------------------
    // بناء المعادلة بخانات: (خانة) + أو - (خانة) ...
    // ------------------------------------------------------------------

    /** كل ما يصلح مرجعاً، باسم معروض يُكتب في الخانة ورمز يدخل المعادلة */
    get references() {
        if (!this.state.references) {
            return { all: [], byLabel: {}, byToken: {} };
        }
        const all = [];
        for (const item of this.state.references.groups) {
            all.push({ token: item.token, label: `باب: ${item.token.slice(1, -1)}` });
        }
        for (const item of this.state.references.lines) {
            all.push({ token: item.token, label: `بند: ${item.token.slice(1, -1)}` });
        }
        for (const item of this.state.references.accounts) {
            all.push({ token: item.token, label: `${item.token.slice(1, -1)} — ${item.label}` });
        }
        const byLabel = {};
        const byToken = {};
        for (const item of all) {
            byLabel[item.label] = item.token;
            byToken[item.token] = item.label;
        }
        return { all, byLabel, byToken };
    }

    labelOf(token) {
        return this.references.byToken[token] || token;
    }

    /** يقرأ معادلة على شكل خانات متتابعة، أو null إن كانت أعقد من ذلك */
    parseTerms(formula) {
        const text = `${formula || ""}`.trim();
        if (!text) {
            return [];
        }
        const pattern = /^\s*([+-]?)\s*(\[[^\]]*\]|\{[^}]*\}|<[^>]*>)\s*/;
        const terms = [];
        let rest = text;
        while (rest.length) {
            const match = pattern.exec(rest);
            if (!match) {
                return null;
            }
            terms.push({ op: match[1] === "-" ? "-" : "+", token: match[2] });
            rest = rest.slice(match[0].length);
        }
        return terms;
    }

    terms(line) {
        const draft = this.state.draftTerms[line.id];
        return draft || this.parseTerms(line.formula) || [];
    }

    /** معادلة لا تُكتب بخانات (أقواس أو ضرب أو قسمة) تبقى نصاً */
    isAdvanced(line) {
        return this.parseTerms(line.formula) === null;
    }

    buildFormula(terms) {
        return terms.map((term, index) => (
            index === 0
                ? (term.op === "-" ? `- ${term.token}` : term.token)
                : ` ${term.op} ${term.token}`
        )).join("");
    }

    async applyTerms(line, terms) {
        if (terms.length && terms.every((term) => term.token)) {
            delete this.state.draftTerms[line.id];
            await this.withBusy(async () => {
                this.state.lines = await this.orm.call(
                    "myaccounting.statement.line", "save_line",
                    [line.id, { formula: this.buildFormula(terms) }]);
                await this.load();
            });
        } else {
            this.state.draftTerms[line.id] = terms;
        }
    }

    onTermSign(line, index, ev) {
        const terms = this.terms(line).map((term) => ({ ...term }));
        terms[index].op = ev.target.value;
        this.applyTerms(line, terms);
    }

    onTermRef(line, index, ev) {
        const token = this.references.byLabel[ev.target.value.trim()] || "";
        const terms = this.terms(line).map((term) => ({ ...term }));
        terms[index].token = token;
        if (!token && ev.target.value.trim()) {
            this.notification.add("لا مرجع بهذا الاسم. اختر من القائمة.", { type: "warning" });
        }
        this.applyTerms(line, terms);
    }

    addTerm(line) {
        const terms = this.terms(line).map((term) => ({ ...term }));
        terms.push({ op: "+", token: "" });
        this.state.draftTerms[line.id] = terms;
    }

    removeTerm(line, index) {
        const terms = this.terms(line).map((term) => ({ ...term }));
        terms.splice(index, 1);
        this.applyTerms(line, terms);
    }

    /** خطأ البند كما حسبه الخادم، ليظهر بجانب معادلته */
    lineError(line) {
        const all = [
            ...(this.data ? this.data.bottom_formulas : []),
            ...(this.data ? this.data.left_formulas : []),
            ...(this.data ? this.data.right_formulas : []),
        ];
        for (const section of this.data ? [...this.data.left, ...this.data.right] : []) {
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
    // الأبواب
    // ------------------------------------------------------------------

    isValue(value, expected) {
        return value === expected;
    }

    async saveGroup(group, field, ev) {
        const value = field === "sequence" ? parseInt(ev.target.value, 10) || 0 : ev.target.value;
        await this.withBusy(async () => {
            this.state.groups = await this.orm.call(
                "myaccounting.statement.group", "save_group", [group.id, { [field]: value }]);
            await Promise.all([this.load(), this.loadSettings()]);
        });
    }

    async addGroup() {
        await this.withBusy(async () => {
            this.state.groups = await this.orm.call(
                "myaccounting.statement.group", "save_group",
                [false, { name: "باب جديد", kind: "balance", side: "debit", sequence: 60 }]);
            await this.loadSettings();
        });
    }

    deleteGroup(group) {
        const body = group.accounts
            ? `هذا الباب مرتبط بـ ${group.accounts} حساباً. بحذفه تعود هذه الحسابات `
              + "بلا تصنيف خاص فترث تصنيف آبائها."
            : "سيُحذف الباب.";
        this.dialog.add(ConfirmationDialog, {
            title: `حذف "${group.name}"`,
            body,
            confirmLabel: "احذف",
            confirm: () => this.withBusy(async () => {
                this.state.groups = await this.orm.call(
                    "myaccounting.statement.group", "delete_group", [group.id]);
                await Promise.all([this.load(), this.loadSettings()]);
            }),
            cancel: () => {},
        });
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

    async onAccountGroup(account, ev) {
        await this.withBusy(async () => {
            this.state.accounts = await this.orm.call(
                "myaccounting.account", "set_statement_account",
                [account.id, ev.target.value ? parseInt(ev.target.value, 10) : false]);
            await this.load();
        });
    }

    async onOpening(account, ev) {
        const amount = parseFloat(ev.target.value) || 0;
        if (amount === account.opening) {
            return;
        }
        await this.withBusy(async () => {
            this.state.accounts = await this.orm.call(
                "myaccounting.account", "set_opening_balance", [account.id, amount]);
            await this.load();
        });
    }

    isAccountGroup(account, groupId) {
        return (account.group_id || false) === (groupId || false);
    }

    indent(level) {
        return `padding-inline-start:${8 + (level || 0) * 16}px;`;
    }

    async withBusy(action) {
        this.state.busy = true;
        try {
            await action();
        } catch (error) {
            this.notification.add(error.data?.message || "تعذّر الحفظ.", { type: "danger" });
            await this.loadSettings();
        } finally {
            this.state.busy = false;
        }
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
