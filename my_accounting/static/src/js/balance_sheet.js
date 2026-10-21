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
        this.state = useState({
            loading: true,
            data: null,
            year: "",
            panel: "",          // groups أو accounts
            groups: [],
            accounts: [],
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
        const [groups, accounts] = await Promise.all([
            this.orm.call("myaccounting.statement.group", "get_groups", []),
            this.orm.call("myaccounting.account", "get_statement_accounts", []),
        ]);
        this.state.groups = groups;
        this.state.accounts = accounts;
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
        this.state.panel = this.state.panel === panel ? "" : panel;
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
