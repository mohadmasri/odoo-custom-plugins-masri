/** @odoo-module **/

import { Component, markRaw, onWillStart, useEffect, useRef, useState } from "@odoo/owl";
import { loadBundle } from "@web/core/assets";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const PALETTE = ["#2E86DE", "#E67E22", "#28A745", "#DC3545", "#8E44AD", "#17A2B8",
    "#F1C40F", "#714B67", "#95A5A6"];
const STATUS = {
    paid: { label: "محصّلة", color: "#28A745" },
    partial: { label: "جزئي", color: "#F1C40F" },
    open: { label: "غير محصّلة", color: "#DC3545" },
};

export const fmt = (value) => (Math.abs(value || 0) < 0.0005 ? 0 : value)
    .toLocaleString("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function periodLabel(data) {
    return data.month ? `${MONTHS[data.month - 1]} ${data.year}` : `سنة ${data.year}`;
}

// ----------------------------------------------------------------------
// إعدادات Chart.js
// ----------------------------------------------------------------------

function textColor() {
    return getComputedStyle(document.body).color;
}

function baseOptions(extra = {}) {
    const color = textColor();
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        color,
        plugins: {
            legend: { position: "bottom", labels: { color, boxWidth: 12 } },
            tooltip: {
                callbacks: {
                    label: (ctx) => {
                        const value = ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed;
                        return `${ctx.dataset.label || ctx.label || ""}: ${fmt(value)}`;
                    },
                },
            },
        },
        ...extra,
    };
}

function noLegend() {
    const plugins = baseOptions().plugins;
    return { ...plugins, legend: { display: false } };
}

function axes(horizontal = false, stacked = false) {
    const color = textColor();
    const grid = { color: "rgba(128, 128, 128, 0.15)" };
    const ticks = { color };
    const valueTicks = { color, callback: (value) => Number(value).toLocaleString("en-US") };
    return horizontal
        ? { x: { grid, ticks: valueTicks, stacked }, y: { grid, ticks, stacked } }
        : { x: { grid, ticks, stacked }, y: { grid, ticks: valueTicks, stacked } };
}

function clickable(handler) {
    return {
        onClick: (_ev, elements) => elements.length && handler(elements[0].index),
        onHover: (ev, elements) => {
            ev.native.target.style.cursor = elements.length ? "pointer" : "default";
        },
    };
}

function pie(slices, { colors = null, onClick = null, doughnut = true } = {}) {
    const options = baseOptions(onClick ? clickable((index) => onClick(slices[index])) : {});
    options.plugins.tooltip.callbacks.label = (ctx) => {
        const total = ctx.dataset.data.reduce((sum, value) => sum + value, 0) || 1;
        return `${ctx.label}: ${fmt(ctx.parsed)} (${Math.round((ctx.parsed / total) * 100)}%)`;
    };
    return {
        type: doughnut ? "doughnut" : "pie",
        data: {
            labels: slices.map((slice) => slice.label),
            datasets: [{
                data: slices.map((slice) => slice.value),
                backgroundColor: colors || slices.map((_s, i) => PALETTE[i % PALETTE.length]),
                borderWidth: 1,
            }],
        },
        options,
    };
}

/**
 * كل التقارير كبطاقات: {key, section, num, title, hint, config, empty, wide}.
 * المفتاح ثابت (يُحفظ عند التثبيت في الرئيسية). nav: {openCustomers, openCustomer}.
 */
export function buildReportCards(data, nav) {
    const labels = MONTHS;
    const highlight = (color) => labels.map((_l, i) => (!data.month || data.month === i + 1 ? color : color + "55"));
    const m = data.monthly;
    const period = periodLabel(data);
    const cards = [];
    const add = (card) => cards.push(card);

    // ------------------------------------------------ الأداء المالي
    add({
        key: "profit", section: "finance", num: 1, wide: true,
        title: "الإيرادات والمصاريف شهرياً",
        hint: "مع خط صافي الربح لكل شهر من السنة",
        config: {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { type: "line", label: "صافي الربح", data: m.profit, borderColor: "#714B67",
                        backgroundColor: "#714B67", tension: 0.3, order: 0 },
                    { label: "الإيرادات", data: m.revenue, backgroundColor: highlight("#28A745"), order: 1 },
                    { label: "المصاريف", data: m.expenses, backgroundColor: highlight("#DC3545"), order: 1 },
                ],
            },
            options: baseOptions({ scales: axes() }),
        },
    });
    add({
        key: "expense_roots", section: "finance", num: 2,
        title: "توزيع المصاريف", hint: period,
        config: data.expense_roots.length ? pie(data.expense_roots) : null,
    });
    add({
        key: "expense_monthly", section: "finance", num: 2,
        title: "المصاريف شهرياً حسب النوع", hint: "إدارية ومشاريع لكل شهر",
        config: {
            type: "bar",
            data: {
                labels,
                datasets: m.expenses_by_root.map((group, i) => ({
                    label: group.label, data: group.values, backgroundColor: PALETTE[i % PALETTE.length],
                })),
            },
            options: baseOptions({ scales: axes(false, true) }),
        },
    });
    for (const group of data.expense_children) {
        add({
            key: `expense_child:${group.root}`, section: "finance", num: 2,
            title: `تفصيل ${group.root}`, hint: period,
            config: group.slices.length ? pie(group.slices) : null,
        });
    }
    add({
        key: "revenue_sources", section: "finance", num: 3,
        title: "مصادر الإيرادات",
        hint: data.revenue_has_children ? period : "حسب الحسابات الفرعية تحت الإيرادات",
        config: data.revenue_has_children && data.revenue_sources.length ? pie(data.revenue_sources) : null,
        empty: data.revenue_has_children ? null
            : "حساب الإيرادات ليس له حسابات فرعية بعد. أنشئ حسابات فرعية تحته (مثل: خدمات، مشاريع، استشارات) ليظهر توزيع الإيرادات هنا.",
    });

    // ------------------------------------------------ العملاء والتحصيل
    const balances = data.customer_balances;
    add({
        key: "customer_balances", section: "customers", num: 4,
        title: "المستحق على كل عميل", hint: "الرصيد حتى نهاية الفترة — اضغط على العميل لفتح سجله",
        config: balances.length ? {
            type: "bar",
            data: {
                labels: balances.map((c) => c.label),
                datasets: [{ label: "المستحق", data: balances.map((c) => c.value), backgroundColor: "#DC3545" }],
            },
            options: baseOptions({
                indexAxis: "y",
                scales: axes(true),
                plugins: noLegend(),
                ...clickable((index) => nav.openCustomer(balances[index].id)),
            }),
        } : null,
    });
    const statuses = data.invoice_status.filter((s) => s.count);
    add({
        key: "invoice_status", section: "customers", num: 5,
        title: "حالة الفواتير", hint: "المبلغ وعدد الفواتير لكل حالة — اضغط لفتح الفواتير",
        config: statuses.length ? pie(
            statuses.map((s) => ({ label: `${STATUS[s.status].label} (${s.count})`, value: s.amount, status: s.status })),
            {
                colors: statuses.map((s) => STATUS[s.status].color),
                onClick: (slice) => nav.openCustomers({ customers_tab: "invoices", invoice_status: slice.status }),
            }
        ) : null,
    });
    add({
        key: "billing", section: "customers", num: 6, wide: true,
        title: "الفوترة مقابل التحصيل شهرياً", hint: "كم فوترت وكم حصّلت في كل شهر",
        config: {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { label: "الفوترة (صافي المرتجعات)", data: m.billed, backgroundColor: highlight("#2E86DE") },
                    { label: "التحصيل (سندات القبض)", data: m.collected, backgroundColor: highlight("#28A745") },
                ],
            },
            options: baseOptions({ scales: axes() }),
        },
    });
    add({
        key: "aging", section: "customers", num: 7,
        title: "أعمار الذمم", hint: "المتبقي على الفواتير حسب عمرها حتى اليوم",
        config: {
            type: "bar",
            data: {
                labels: data.aging.map((b) => `${b.label} (${b.count})`),
                datasets: [{
                    label: "المتبقي على الفواتير",
                    data: data.aging.map((b) => b.amount),
                    backgroundColor: ["#28A745", "#F1C40F", "#E67E22", "#DC3545"],
                }],
            },
            options: baseOptions({
                scales: axes(),
                plugins: noLegend(),
                ...clickable(() => nav.openCustomers({ customers_tab: "invoices", invoice_status: "open" })),
            }),
        },
    });
    add({
        key: "invoiced_by_customer", section: "customers", num: 8,
        title: "حصة كل عميل من الفوترة", hint: `${period} — صافي بعد المرتجعات`,
        config: data.invoiced_by_customer.length ? pie(data.invoiced_by_customer, {
            doughnut: false,
            onClick: (slice) => nav.openCustomer(slice.id),
        }) : null,
    });

    // ------------------------------------------------ النقد والالتزامات
    add({
        key: "bank", section: "cash", num: 9,
        title: `رصيد ${data.bank_name} عبر الأشهر`, hint: "الرصيد في نهاية كل شهر (مدين − دائن)",
        config: {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: `رصيد ${data.bank_name}`,
                    data: m.bank_balance,
                    borderColor: "#2E86DE",
                    backgroundColor: "rgba(46, 134, 222, 0.15)",
                    fill: true,
                    tension: 0.3,
                    pointRadius: labels.map((_l, i) => (data.month === i + 1 ? 6 : 3)),
                }],
            },
            options: baseOptions({ scales: axes() }),
        },
    });
    add({
        key: "liabilities", section: "cash", num: 10,
        title: "الضريبة والضمان الاجتماعي شهرياً", hint: "صافي المستحق في كل شهر (دائن − مدين)",
        config: {
            type: "bar",
            data: {
                labels,
                datasets: [
                    { label: "ضريبة المبيعات", data: m.tax, backgroundColor: highlight("#E67E22") },
                    { label: "الضمان الاجتماعي", data: m.ss, backgroundColor: highlight("#8E44AD") },
                ],
            },
            options: baseOptions({ scales: axes() }),
        },
    });
    return cards;
}

// ----------------------------------------------------------------------
// المكوّنات
// ----------------------------------------------------------------------

/** رسم واحد بـ Chart.js: يُعاد إنشاؤه عند تغيّر الإعدادات. */
export class ReportChart extends Component {
    static template = "my_accounting.ReportChart";
    static props = ["config"];

    setup() {
        this.canvasRef = useRef("canvas");
        useEffect(
            (config) => {
                const chart = new window.Chart(this.canvasRef.el, config);
                return () => chart.destroy();
            },
            () => [this.props.config]
        );
    }
}

/**
 * بطاقة تقرير: عنوان + وصف + الرسم، مع زر تثبيت في الرئيسية (صفحة التقارير)
 * أو زر إزالة (الصفحة الرئيسية).
 */
export class ReportCard extends Component {
    static template = "my_accounting.ReportCard";
    static components = { ReportChart };
    static props = ["card", "pinned?", "onTogglePin?", "onRemove?"];
}

/** خدمات التنقل عند الضغط على الرسوم (مشتركة بين صفحة التقارير والرئيسية). */
export function reportNav(actionService) {
    const openCustomers = (context) =>
        actionService.doAction("my_accounting.action_myaccounting_customers", { additionalContext: context });
    return {
        openCustomers,
        openCustomer: (customerId) => customerId && openCustomers({ customer_id: customerId, customers_tab: "all" }),
    };
}

/**
 * صفحة التقارير: بطاقات أرقام + كل الرسوم، مع 📌 على كل رسم لتثبيته في الصفحة الرئيسية.
 */
export class ReportsPage extends Component {
    static template = "my_accounting.Reports";
    static components = { ReportCard };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.nav = reportNav(this.actionService);
        this.fmt = fmt;
        this.sections = [
            { key: "finance", title: "الأداء المالي", icon: "fa-balance-scale" },
            { key: "customers", title: "العملاء والتحصيل", icon: "fa-users" },
            { key: "cash", title: "النقد والالتزامات", icon: "fa-university" },
        ];
        this.state = useState({
            data: null, loading: true, year: false, month: 0, includeDrafts: false, pinned: [],
        });
        this.cards = [];
        onWillStart(async () => {
            await loadBundle("web.chartjs_lib");
            this.state.pinned = await this.orm.call("myaccounting.reports", "get_home_report_keys", []);
            await this.loadData();
        });
    }

    async loadData() {
        this.state.loading = true;
        const data = await this.orm.call("myaccounting.reports", "get_reports_data", [], {
            year: this.state.year || false,
            month: this.state.month || false,
            include_drafts: this.state.includeDrafts,
        });
        this.state.year = data.year;
        this.cards = markRaw(buildReportCards(data, this.nav));
        this.state.data = data;
        this.state.loading = false;
    }

    cardsOf(section) {
        return this.cards.filter((card) => card.section === section);
    }

    get periodLabel() {
        return periodLabel(this.state.data);
    }

    onYear(ev) {
        this.state.year = parseInt(ev.target.value, 10);
        this.loadData();
    }

    onMonthButton(month) {
        this.state.month = this.state.month === month ? 0 : month;
        this.loadData();
    }

    toggleDrafts(ev) {
        this.state.includeDrafts = ev.target.checked;
        this.loadData();
    }

    async togglePin(card) {
        const pinned = !this.state.pinned.includes(card.key);
        this.state.pinned = await this.orm.call("myaccounting.reports", "set_home_report", [card.key, pinned]);
        this.notification.add(
            pinned ? `أُضيف "${card.title}" إلى الصفحة الرئيسية.` : `أُزيل "${card.title}" من الصفحة الرئيسية.`,
            { type: pinned ? "success" : "info" }
        );
    }
}

/**
 * التقارير المثبّتة في الصفحة الرئيسية (أسفل المربعات الأربعة)، بالسنة الحالية.
 */
export class HomeReports extends Component {
    static template = "my_accounting.HomeReports";
    static components = { ReportCard };
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.nav = reportNav(this.actionService);
        this.state = useState({ loaded: false, keys: [], period: "" });
        this.cards = [];
        onWillStart(async () => {
            await loadBundle("web.chartjs_lib");
            try {
                await this.load();
            } catch {
                this.state.loaded = false; // بلا صلاحية: لا يظهر القسم
            }
        });
    }

    async load() {
        const result = await this.orm.call("myaccounting.reports", "get_home_reports", []);
        const all = result.data ? buildReportCards(result.data, this.nav) : [];
        // بترتيب التثبيت، مع تجاهل تقارير لم تعد موجودة (مثل تفصيل حساب حُذف)
        this.cards = markRaw(result.keys.map((key) => all.find((card) => card.key === key)).filter(Boolean));
        this.state.keys = result.keys;
        this.state.period = result.data ? periodLabel(result.data) : "";
        this.state.loaded = true;
    }

    async remove(card) {
        await this.orm.call("myaccounting.reports", "set_home_report", [card.key, false]);
        this.cards = markRaw(this.cards.filter((c) => c.key !== card.key));
        this.state.keys = this.state.keys.filter((key) => key !== card.key);
    }

    openReports() {
        this.actionService.doAction("my_accounting.action_myaccounting_reports");
    }
}

registry.category("actions").add("my_accounting.reports", ReportsPage);
