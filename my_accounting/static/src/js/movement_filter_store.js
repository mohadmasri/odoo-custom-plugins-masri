/** @odoo-module **/

// فلتر الحركة المشترك بين شجرة الحسابات ولوحة حركات الحساب: يُحفظ في جلسة
// المتصفح الحالية فقط، حتى يبقى الفلتر عند الدخول إلى حساب من الشجرة وعند
// الرجوع إليها، وأي تعديل أو إلغاء داخل الحساب ينعكس على الشجرة أيضاً.

const STORAGE_KEY = "my_accounting.movement_filter";

export const FILTER_FIELDS = ["dateFrom", "dateTo", "moveFrom", "moveTo", "ledgerFrom", "ledgerTo"];

export function emptyMovementFilter() {
    return Object.fromEntries(FILTER_FIELDS.map((field) => [field, ""]));
}

export function hasMovementFilter(filter) {
    return !!filter && FILTER_FIELDS.some((field) => (filter[field] || "").toString().trim());
}

export function loadMovementFilter() {
    try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return null;
        }
        const stored = JSON.parse(raw);
        const filter = emptyMovementFilter();
        for (const field of FILTER_FIELDS) {
            filter[field] = typeof stored[field] === "string" ? stored[field] : "";
        }
        return hasMovementFilter(filter) ? filter : null;
    } catch {
        return null;
    }
}

export function saveMovementFilter(filter) {
    try {
        if (!hasMovementFilter(filter)) {
            window.sessionStorage.removeItem(STORAGE_KEY);
            return;
        }
        const clean = {};
        for (const field of FILTER_FIELDS) {
            clean[field] = (filter[field] || "").toString().trim();
        }
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } catch {
        // التخزين غير متاح (نافذة خاصة مثلاً): يعمل الفلتر دون أن يُحفظ
    }
}

// المعاملات كما يتوقعها الخادم (get_movement_filter / get_tree_filter_data)
export function movementFilterParams(filter) {
    const value = (field) => (filter[field] || "").toString().trim() || false;
    return {
        date_from: value("dateFrom"),
        date_to: value("dateTo"),
        move_from: value("moveFrom"),
        move_to: value("moveTo"),
        ledger_from: value("ledgerFrom"),
        ledger_to: value("ledgerTo"),
    };
}
