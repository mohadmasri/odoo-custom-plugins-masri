/** @odoo-module **/

import { Component, useState, onWillStart } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { BulkAccountDialog } from "./account_bulk_dialog";

class AccountTreeNode extends Component {
    static template = "my_accounting.AccountTreeNode";
    static props = ["node", "depth", "expanded", "selected", "onToggle", "onOpen", "onAddChild", "onToggleSelect"];

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
    static components = { AccountTreeNode };

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.dialogService = useService("dialog");
        this.state = useState({ roots: [], expanded: {}, selected: {}, allIds: [] });
        onWillStart(() => this.loadData());
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
            byId[r.id] = { ...r, children: [] };
        });
        const roots = [];
        records.forEach((r) => {
            const node = byId[r.id];
            if (r.parent_id) {
                const parent = byId[r.parent_id[0]];
                if (parent) {
                    parent.children.push(node);
                } else {
                    roots.push(node);
                }
            } else {
                roots.push(node);
            }
        });
        this.state.roots = roots;
        this.state.allIds = records.map((r) => r.id);
    }

    toggle(id) {
        this.state.expanded[id] = !this.state.expanded[id];
    }

    get selectedIds() {
        return Object.keys(this.state.selected)
            .filter((id) => this.state.selected[id])
            .map((id) => parseInt(id, 10));
    }

    get allSelected() {
        return this.state.allIds.length > 0 &&
            this.state.allIds.every((id) => this.state.selected[id]);
    }

    findNode(id, nodes = this.state.roots) {
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

    // عند اختيار حساب له حسابات فرعية، تُحدَّد كل الحسابات التي تحته تلقائياً
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
        const checked = ev.target.checked;
        const selected = {};
        if (checked) {
            for (const id of this.state.allIds) {
                selected[id] = true;
            }
        }
        this.state.selected = selected;
    }

    clearSelection() {
        this.state.selected = {};
    }

    printSelected() {
        const ids = this.selectedIds;
        if (!ids.length) {
            return;
        }
        this.actionService.doAction({
            type: "ir.actions.report",
            report_name: "my_accounting.report_myaccounting_account_statement",
            report_type: "qweb-html",
            context: { active_ids: ids },
        });
    }

    openAccount(id) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.account",
            res_id: id,
            views: [[false, "form"]],
            target: "current",
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
