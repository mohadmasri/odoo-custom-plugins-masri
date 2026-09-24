/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";
import { openRecord } from "./open_record";

const MAX_SIDE = 2000; // تصغير الصورة قبل الرفع: أسرع على الهاتف وأقل كلفة عند القراءة

/**
 * صفحة "إضافة قيد عبر صورة (BETA)": تُفتح من الهاتف لتصوير المستندات ورفعها،
 * أو تُختار عدة صور من الجهاز دفعة واحدة. كل صورة تصبح قيد صورة مستقلاً.
 * القراءة بـ Claude أو Gemini تتم لاحقاً من الحاسوب من شاشة "صور القيود"،
 * والصورة تبقى محفوظة حتى ترحيل القيد.
 */
export class PhotoCapturePage extends Component {
    static template = "my_accounting.PhotoCapture";
    static props = ["*"];

    setup() {
        this.orm = useService("orm");
        this.actionService = useService("action");
        this.notification = useService("notification");
        this.cameraRef = useRef("camera");
        this.galleryRef = useRef("gallery");
        this.state = useState({
            info: null,
            // الصور المختارة بانتظار الرفع: { key, preview, data, mediaType }
            queue: [],
            uploading: false,
            progress: 0, // كم صورة رُفعت من الدفعة الحالية
            uploaded: null, // { count, label }
            error: null,
            keyProvider: null, // المفتاح الجاري تعديله: claude | gemini
            apiKey: "",
            geminiModel: "",
        });
        onWillStart(() => this.loadInfo());
    }

    async loadInfo() {
        this.state.info = await this.orm.call("myaccounting.photo.entry", "get_photo_page_info", []);
        this.state.geminiModel = this.state.info.gemini_model;
    }

    // ------------------------------------------------------------------
    // المفاتيح (مدير النظام)
    // ------------------------------------------------------------------

    editKey(provider) {
        this.state.keyProvider = provider;
        this.state.apiKey = "";
    }

    async saveKey() {
        await this.orm.call("myaccounting.photo.entry", "set_api_key", [this.state.apiKey, this.state.keyProvider]);
        const name = this.state.keyProvider === "gemini" ? "Gemini" : "Claude";
        this.state.keyProvider = null;
        this.state.apiKey = "";
        this.notification.add(`تم حفظ مفتاح ${name} API.`, { type: "success" });
        await this.loadInfo();
    }

    async saveGeminiModel() {
        await this.orm.call("myaccounting.photo.entry", "set_gemini_model", [this.state.geminiModel]);
        this.notification.add("تم حفظ نموذج Gemini.", { type: "success" });
        await this.loadInfo();
    }

    // ------------------------------------------------------------------
    // التصوير والرفع
    // ------------------------------------------------------------------

    openCamera() {
        this.cameraRef.el.click();
    }

    openGallery() {
        this.galleryRef.el.click();
    }

    async onFile(ev) {
        const files = [...(ev.target.files || [])];
        ev.target.value = "";
        if (!files.length) {
            return;
        }
        this.state.uploaded = null;
        this.state.error = null;
        let failed = 0;
        for (const file of files) {
            try {
                const dataUrl = await this.resize(file);
                this.state.queue.push({
                    key: `${Date.now()}-${this.state.queue.length}`,
                    preview: dataUrl,
                    data: dataUrl.split(",")[1],
                    mediaType: "image/jpeg",
                });
            } catch {
                failed += 1;
            }
        }
        if (failed) {
            this.state.error = failed === files.length
                ? "تعذّر فتح الصور المختارة. جرّب صوراً أخرى."
                : `تعذّر فتح ${failed} من الصور المختارة، والباقي جاهز للرفع.`;
        }
    }

    removeImage(index) {
        this.state.queue.splice(index, 1);
    }

    clearQueue() {
        this.state.queue = [];
    }

    // تصغير الصورة إلى MAX_SIDE بكسل كحد أقصى وتحويلها إلى JPEG
    resize(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL("image/jpeg", 0.88));
            };
            img.onerror = (error) => {
                URL.revokeObjectURL(url);
                reject(error);
            };
            img.src = url;
        });
    }

    // لف صورة قبل الرفع (90 = يميناً مع عقارب الساعة، -90 = يساراً)
    rotate(degrees, index = 0) {
        const item = this.state.queue[index];
        if (!item) {
            return;
        }
        const source = new Image();
        source.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = source.height;
            canvas.height = source.width;
            const ctx = canvas.getContext("2d");
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate((degrees * Math.PI) / 180);
            ctx.drawImage(source, -source.width / 2, -source.height / 2);
            const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
            item.preview = dataUrl;
            item.data = dataUrl.split(",")[1];
        };
        source.src = item.preview;
    }

    // ترفع كل الصور المختارة، كل واحدة قيد صورة مستقل
    async upload() {
        if (!this.state.queue.length || this.state.uploading) {
            return;
        }
        this.state.uploading = true;
        this.state.progress = 0;
        this.state.error = null;
        const saved = [];
        try {
            for (const item of [...this.state.queue]) {
                const result = await this.orm.call("myaccounting.photo.entry", "upload_image",
                    [item.data, item.mediaType]);
                saved.push(result.label);
                this.state.progress = saved.length;
                this.state.queue.shift();
            }
        } catch (error) {
            this.state.error = error.data?.message || error.message || "تعذّر رفع الصورة.";
        } finally {
            this.state.uploading = false;
            if (saved.length) {
                this.state.uploaded = {
                    count: saved.length,
                    label: saved.length === 1 ? saved[0] : `${saved.length} صور`,
                };
            }
            await this.loadInfo();
        }
    }

    retake() {
        this.state.queue = [];
        this.openCamera();
    }

    nextPhoto() {
        this.state.uploaded = null;
        this.openCamera();
    }

    morePhotos() {
        this.state.uploaded = null;
        this.openGallery();
    }

    stateLabel(state) {
        return { new: "بانتظار القراءة", review: "بانتظار التأكيد" }[state] || state;
    }

    openEntry(id, isMiddleClick = false) {
        openRecord(this.actionService, "myaccounting.photo.entry", id, isMiddleClick);
    }

    openList() {
        this.actionService.doAction("my_accounting.action_myaccounting_photo_entries");
    }
}

registry.category("actions").add("my_accounting.photo_capture", PhotoCapturePage);
