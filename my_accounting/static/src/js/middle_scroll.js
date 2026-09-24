/** @odoo-module **/

import { CLICKABLE_PAGES } from "./open_record";

/**
 * التمرير بالزر الأوسط داخل شاشاتنا.
 *
 * لكي تفتح الضغطة الواحدة تبويباً جديداً كان لا بدّ من منع دائرة التمرير
 * التلقائي التي يبدؤها المتصفح فور ضغط الزر الأوسط (وإلا ابتلعت النقرة).
 * فنحن نقوم بالتمرير بأنفسنا: ما دمت ضاغطاً وتحرّك الفأرة، تُمرَّر الصفحة
 * باتجاه الحركة وبسرعة تتناسب مع بُعدك عن نقطة الضغط، تماماً كسلوك المتصفح.
 *
 * وإن أفلتّ الزر دون تحريك، فهي نقرة: يفتح السجل في تبويب جديد كما هو.
 */

const DEAD_ZONE = 10; // بكسل: حركة أقل منها لا تُمرّر شيئاً
const MOVE_THRESHOLD = 6; // بكسل: بعدها تُعدّ الحركة تمريراً لا نقرة
const SPEED = 12; // كلما صغر الرقم زادت السرعة
const FRAME_MS = 16;

let press = null;

/** أقرب عنصر حوله يمكن تمريره */
function scrollable(el) {
    for (let node = el; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) &&
            node.scrollHeight > node.clientHeight + 1;
        const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX) &&
            node.scrollWidth > node.clientWidth + 1;
        if (canScrollY || canScrollX) {
            return node;
        }
    }
    return document.scrollingElement || document.documentElement;
}

function step() {
    if (!press || !press.scrolling) {
        return;
    }
    const pull = (delta) => {
        const distance = Math.abs(delta) - DEAD_ZONE;
        return distance <= 0 ? 0 : Math.sign(delta) * (distance / SPEED);
    };
    press.el.scrollBy({ top: pull(press.dy), left: pull(press.dx), behavior: "instant" });
}

function stop() {
    if (!press) {
        return;
    }
    clearInterval(press.timer);
    document.body.style.cursor = press.cursor;
    const scrolled = press.scrolling;
    press = null;
    if (scrolled) {
        // كانت حركة تمرير لا نقرة: نمنع فتح التبويب الذي يلي الإفلات
        const swallow = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
        };
        window.addEventListener("auxclick", swallow, true);
        setTimeout(() => window.removeEventListener("auxclick", swallow, true));
    }
}

document.addEventListener("mousedown", (ev) => {
    if (ev.button !== 1 || !(ev.target instanceof Element)) {
        return;
    }
    const page = ev.target.closest(CLICKABLE_PAGES);
    if (!page) {
        return; // خارج شاشاتنا: المتصفح يتصرّف كعادته
    }
    ev.preventDefault(); // لا دائرة تمرير من المتصفح، فالتمرير من عندنا
    press = {
        x: ev.clientX,
        y: ev.clientY,
        dx: 0,
        dy: 0,
        el: scrollable(ev.target),
        scrolling: false,
        cursor: document.body.style.cursor,
        timer: setInterval(step, FRAME_MS),
    };
});

document.addEventListener("mousemove", (ev) => {
    if (!press) {
        return;
    }
    press.dx = ev.clientX - press.x;
    press.dy = ev.clientY - press.y;
    if (!press.scrolling && Math.hypot(press.dx, press.dy) > MOVE_THRESHOLD) {
        press.scrolling = true;
        document.body.style.cursor = "all-scroll";
    }
});

document.addEventListener("mouseup", (ev) => {
    if (press && ev.button === 1) {
        stop();
    }
});

// الإفلات خارج النافذة أو فقدان التركيز: ننهي التمرير بأمان
window.addEventListener("blur", stop);
document.addEventListener("mouseleave", stop);
