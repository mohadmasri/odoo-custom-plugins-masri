/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { PeriodFilter } from "./period_filter";
import { openRecord } from "./open_record";
import { user } from "@web/core/user";
import { BulkAccountDialog } from "./account_bulk_dialog";
import {
    emptyMovementFilter,
    loadMovementFilter,
    movementFilterParams,
    saveMovementFilter,
} from "./movement_filter_store";

// توحيد النص العربي للبحث الذكي: إزالة التشكيل والتطويل، توحيد أشكال الألف
// والياء والتاء المربوطة، تحويل الأرقام الهندية، وتجاهل "ال" التعريف في بداية
// كل كلمة؛ فيجد "صندوق" حساب "الصندوق"، و"مؤسسه" حساب "مؤسسة".
function normalizeSearchText(value) {
    return (value || "")
        .toString()
        .toLowerCase()
        .replace(/[ً-ٰٟـ]/g, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ى/g, "ي")
        .replace(/ئ/g, "ي")
        .replace(/ؤ/g, "و")
        .replace(/ة/g, "ه")
        .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
        .split(/[\s\-_/.,،()]+/)
        .filter(Boolean)
        .map((word) => (word.length > 3 && word.startsWith("ال") ? word.slice(2) : word))
        .join(" ");
}

function pad(n) {
    return String(n).padStart(2, "0");
}

class AccountTreeNode extends Component {
    static template = "my_accounting.AccountTreeNode";
    static props = ["node", "depth", "expanded", "selected", "filterActive",
                    "onToggle", "onOpen", "onAddChild", "onToggleSelect"];

    get node() {
        return this.props.node;
    }
    get hasChildren() {
        return this.props.node.children.length > 0;
    }
    get isExpanded() {
        return !!this.props.expanded[this.props.node.id];
    }
    get indentStyle() {
        return `padding-inline-start: ${this.props.depth * 24}px;`;
    }
    get formattedBalance() {
        return (this.props.node.balance || 0).toFixed(3);
    }
    get balanceClass() {
        const bal = this.props.node.balance || 0;
        if (bal > 0) return "text-success";
        if (bal < 0) return "text-danger";
        return "text-muted";
    }
}
AccountTreeNode.components = { AccountTreeNode };

export class AccountTree extends Component {
    static template = "my_accounting.AccountTree";
    static props = ["*"];
    static components = { AccountTreeNode, PeriodFilter };

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.notification = useService("notification");
        this.state = useState({
            roots: [],
            expanded: {},
            selected: {},
            search: "",
            moveNames: [],
            // السنة المختارة من القائمة قبل الضغط على شهر (لا فلتر بعد)
            yearHint: "",
            // قيم حقول الفلتر كما يكتبها المستخدم
            filterForm: emptyMovementFilter(),
            // الفلتر المطبَّق فعلاً (بعد الضغط على "تطبيق") + حركة الحسابات ضمنه
            filter: null,
        });
        onWillStart(async () => {
            await Promise.all([this.loadData(), this.loadMoveNames()]);
            // استعادة الفلتر المحفوظ (عند الرجوع من داخل حساب، أو إن عُدّل هناك)
            const stored = loadMovementFilter();
            if (stored) {
                this.state.filterForm = stored;
                await this.applyFilter();
            }
        });
    }

    async loadData() {
        const records = await this.orm.searchRead(
            "myaccounting.account",
            [],
            ["code", "name", "balance", "reviewed", "parent_id"],
            { order: "code_path" }
        );
        const byId = {};
        records.forEach((r) => {
            byId[r.id] = { ...r, children: [], searchKey: normalizeSearchText(`${r.code} ${r.name}`) };
        });
        const roots = [];
        records.forEach((r) => {
            const node = byId[r.id];
            const parent = r.parent_id && byId[r.parent_id[0]];
            if (parent) {
                parent.children.push(node);
            } else {
                roots.push(node);
            }
        });
        this.state.roots = roots;
        if (this.state.filter) {
            await this.applyFilter();
        }
    }

    async loadMoveNames() {
        this.state.moveNames = await this.orm.call("myaccounting.account", "get_move_names", []);
    }

    // ---------------------------------------------------------------------
    // فلتر الحركة (تاريخ / رقم قيد)
    // ---------------------------------------------------------------------

    get filterYear() {
        const form = this.state.filterForm;
        return (form.ledgerFrom || form.ledgerTo || "").split("-")[0] || this.state.yearHint || "";
    }

    // شهر واحد مفعّل في فلتر الحركة
    get filterMonth() {
        const form = this.state.filterForm;
        return form.ledgerFrom && form.ledgerFrom === form.ledgerTo
            ? String(parseInt(form.ledgerFrom.split("-")[1], 10))
            : "";
    }

    // فلتر الفترة الموحّد: الشهر يملأ (من شهر - إلى شهر) في فلتر الحركة
    async onPeriodChange({ year, month }) {
        const form = this.state.filterForm;
        if (!month) {
            // سنة بلا شهر: تُحفظ لاستخدامها عند الضغط على شهر، ويُلغى فلتر الشهر
            this.state.yearHint = year;
            const hadMonth = !!(form.ledgerFrom || form.ledgerTo);
            form.ledgerFrom = "";
            form.ledgerTo = "";
            if (hadMonth) {
                await this.applyFilter();
            }
            return;
        }
        const value = `${year}-${pad(parseInt(month, 10))}`;
        form.ledgerFrom = value;
        form.ledgerTo = value;
        await this.applyFilter();
    }

    get hasFilterInput() {
        const f = this.state.filterForm;
        return !!(f.dateFrom || f.dateTo || f.moveFrom.trim() || f.moveTo.trim() || f.ledgerFrom || f.ledgerTo);
    }

    async applyFilter() {
        const f = this.state.filterForm;
        if (!this.hasFilterInput) {
            this.clearFilter();
            return;
        }
        for (const name of [f.moveFrom.trim(), f.moveTo.trim()]) {
            if (name && !this.state.moveNames.includes(name)) {
                this.notification.add(`رقم القيد "${name}" غير موجود.`, { type: "danger" });
                return;
            }
        }
        const params = movementFilterParams(f);
        const data = await this.orm.call("myaccounting.account", "get_tree_filter_data", [], params);
        saveMovementFilter(f);
        this.state.filter = {
            dateFrom: params.date_from,
            // القيم الافتراضية المحسوبة على الخادم: اليوم / آخر قيد
            dateTo: data.date_to,
            moveFrom: data.move_from,
            moveTo: data.move_to,
            // الشهر الحالي افتراضياً إن لم يُحدَّد "إلى شهر أستاذ"
            ledgerFrom: params.ledger_from,
            ledgerTo: data.ledger_to,
            accounts: data.accounts,
        };
        this.expandToVisible();
    }

    clearFilter() {
        this.state.filterForm = emptyMovementFilter();
        this.state.filter = null;
        saveMovementFilter(null);
    }

    onFilterKeydown(ev) {
        if (ev.key === "Enter") {
            this.applyFilter();
        }
    }

    get movementAccountsCount() {
        return this.state.filter ? Object.keys(this.state.filter.accounts).length : 0;
    }

    // ---------------------------------------------------------------------
    // البحث الذكي
    // ---------------------------------------------------------------------

    get searchTokens() {
        return normalizeSearchText(this.state.search).split(" ").filter(Boolean);
    }

    matchesSearch(node) {
        const tokens = this.searchTokens;
        return tokens.length > 0 && tokens.every((token) => node.searchKey.includes(token));
    }

    onSearchInput(ev) {
        this.state.search = ev.target.value;
        this.expandToVisible();
    }

    clearSearch() {
        this.state.search = "";
    }

    // ---------------------------------------------------------------------
    // الشجرة المعروضة بعد تطبيق الفلتر والبحث
    // ---------------------------------------------------------------------

    /**
     * يبني نسخة من الشجرة تحتوي فقط على:
     *  - مع الفلتر: الحسابات التي عليها حركة ضمنه، وآباؤها لإظهار التسلسل.
     *  - مع البحث: الحسابات المطابقة (مع ما تحتها) وآباؤها.
     * في وضع الفلتر يعرض عمود الرصيد صافي الحركة (مدين - دائن) ضمن الفلتر.
     */
    get displayRoots() {
        const filter = this.state.filter;
        const searching = this.searchTokens.length > 0;
        const build = (node, ancestorMatched) => {
            const matched = searching && this.matchesSearch(node);
            const children = node.children
                .map((child) => build(child, ancestorMatched || matched))
                .filter(Boolean);
            const movement = filter ? filter.accounts[node.id] : null;
            if (filter && !movement && !children.length) {
                return null;
            }
            if (searching && !matched && !ancestorMatched && !children.length) {
                return null;
            }
            return {
                ...node,
                children,
                matched,
                hasMovement: !!movement,
                movementCount: movement ? movement.count : 0,
                balance: filter ? (movement ? movement.debit - movement.credit : 0) : node.balance,
            };
        };
        return this.state.roots.map((root) => build(root, false)).filter(Boolean);
    }

    get isNarrowed() {
        return !!this.state.filter || this.searchTokens.length > 0;
    }

    get visibleIds() {
        const ids = [];
        const walk = (nodes) => nodes.forEach((n) => { ids.push(n.id); walk(n.children); });
        walk(this.displayRoots);
        return ids;
    }

    // عند تطبيق فلتر أو بحث نفتح الفروع تلقائياً حتى تظهر النتائج مباشرة
    expandToVisible() {
        if (!this.isNarrowed) {
            return;
        }
        const expanded = { ...this.state.expanded };
        const walk = (nodes) => {
            for (const node of nodes) {
                if (node.children.length) {
                    expanded[node.id] = true;
                    walk(node.children);
                }
            }
        };
        walk(this.displayRoots);
        this.state.expanded = expanded;
    }

    toggle(id) {
        this.state.expanded[id] = !this.state.expanded[id];
    }

    // ---------------------------------------------------------------------
    // التحديد والطباعة
    // ---------------------------------------------------------------------

    get selectedIds() {
        return Object.keys(this.state.selected)
            .filter((id) => this.state.selected[id])
            .map((id) => parseInt(id, 10));
    }

    // الحسابات المحددة والظاهرة حالياً فقط (أي التي عليها حركة ضمن الفلتر إن وُجد)،
    // فلا يُطبع حساب محدد سابقاً ثم أخفاه الفلتر أو البحث.
    get printableIds() {
        const visible = new Set(this.visibleIds);
        return this.selectedIds.filter((id) => visible.has(id));
    }

    get allSelected() {
        const ids = this.visibleIds;
        return ids.length > 0 && ids.every((id) => this.state.selected[id]);
    }

    findNode(id, nodes = this.displayRoots) {
        for (const node of nodes) {
            if (node.id === id) {
                return node;
            }
            const found = this.findNode(id, node.children);
            if (found) {
                return found;
            }
        }
        return null;
    }

    collectIds(node) {
        let ids = [node.id];
        for (const child of node.children) {
            ids = ids.concat(this.collectIds(child));
        }
        return ids;
    }

    // عند اختيار حساب له حسابات فرعية، تُحدَّد كل الحسابات الظاهرة التي تحته تلقائياً
    // (وكل مستوياتها الفرعية). عند إلغاء التحديد لا يُلغى تحديد ما تحته، حتى
    // يمكن اختيار حساب رئيسي بكل فروعه ثم إلغاء تحديد الرئيسي فقط والإبقاء
    // على الفروع محددة (مثلاً لحذفها كلها دون حذف الحساب الرئيسي نفسه).
    toggleSelect(id, checked) {
        const selected = { ...this.state.selected };
        if (checked) {
            const node = this.findNode(id);
            const ids = node ? this.collectIds(node) : [id];
            for (const nid of ids) {
                selected[nid] = true;
            }
        } else {
            delete selected[id];
        }
        this.state.selected = selected;
    }

    toggleSelectAll(ev) {
        const selected = {};
        if (ev.target.checked) {
            for (const id of this.visibleIds) {
                selected[id] = true;
            }
        }
        this.state.selected = selected;
    }

    clearSelection() {
        this.state.selected = {};
    }

    printSelected() {
        const ids = this.printableIds;
        if (!ids.length) {
            return;
        }
        const filter = this.state.filter;
        if (!filter) {
            this.actionService.doAction({
                type: "ir.actions.report",
                report_name: "my_accounting.report_myaccounting_account_statement",
                report_type: "qweb-html",
                context: { active_ids: ids },
            });
            return;
        }
        // doAction لا يمرر مفاتيح context المخصصة إلى رابط تقرير qweb-html،
        // لذا نبني الرابط يدوياً مع نفس قيم الفلتر المطبّق، فتطابق الطباعة الشاشة.
        const context = {
            ...user.context,
            date_from: filter.dateFrom || false,
            date_to: filter.dateTo || false,
            move_from: filter.moveFrom || false,
            move_to: filter.moveTo || false,
            ledger_from: filter.ledgerFrom || false,
            ledger_to: filter.ledgerTo || false,
        };
        const url = `/report/html/my_accounting.report_myaccounting_account_statement/${ids.join(",")}` +
            `?context=${encodeURIComponent(JSON.stringify(context))}`;
        window.open(url, "_blank");
    }

    // ---------------------------------------------------------------------

    openAccount(id, isMiddleClick = false) {
        // نمرّر علامة للوحة حركات الحساب حتى تطبّق نفس فلتر الشجرة المحفوظ،
        // ونمرّر الحسابات الظاهرة للتنقل بينها بالأسهم داخل الحساب.
        openRecord(this.actionService, "myaccounting.account", id, isMiddleClick, {
            props: { resIds: this.visibleIds },
            context: { my_accounting_from_tree: true },
        });
    }

    createAccount(parentId) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.account",
            views: [[false, "form"]],
            target: "current",
            context: parentId ? { default_parent_id: parentId } : {},
        });
    }

    openBulkCreateDialog(parentId) {
        this.dialogService.add(BulkAccountDialog, {
            defaultParentId: parentId || false,
            onCreated: () => this.loadData(),
        });
    }

    openReview() {
        this.actionService.doAction("my_accounting.action_myaccounting_account_review");
    }
}

registry.category("actions").add("my_accounting.account_tree", AccountTree);
