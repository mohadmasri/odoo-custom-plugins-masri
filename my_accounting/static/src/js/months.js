/** @odoo-module **/

/**
 * أسماء الأشهر العربية المشرقية، مصدراً واحداً لكل الشاشات.
 *
 * وكل قائمة اختيارٍ للأشهر تُسمّي الشهر برقمه قبل اسمه: «1 - كانون الثاني»،
 * فيُعرف الشهر بأيّهما نظر إليه. أي تعديلٍ هنا يظهر في الصفحات كلها.
 */
export const MONTH_NAMES = [
    "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
    "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
];

/** اسم الشهر من رقمه (1..12) */
export function monthName(month) {
    return MONTH_NAMES[Number(month) - 1] || "";
}

/** «3 - آذار»: ما يُكتب في قوائم الاختيار */
export function monthLabel(month) {
    const name = monthName(month);
    return name ? `${Number(month)} - ${name}` : "";
}

/** [["1", "1 - كانون الثاني"], ...] لقوائم <option> */
export const MONTH_OPTIONS = MONTH_NAMES.map(
    (name, index) => [String(index + 1), `${index + 1} - ${name}`]);

/** [{ value, label }, ...] لمن يحتاج الخيارات كائناتٍ */
export const MONTH_CHOICES = MONTH_OPTIONS.map(
    ([value, label]) => ({ value, label }));
