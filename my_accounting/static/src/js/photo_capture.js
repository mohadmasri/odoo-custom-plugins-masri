/** @odoo-module **/

import { Component, onWillStart, useRef, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useService } from "@web/core/utils/hooks";

const MAX_SIDE = 2000; // تصغير الصورة قبل الرفع: أسرع على الهاتف وأقل كلفة عند القراءة

/**
 * صفحة "إضافة قيد عبر صورة (BETA)": تُفتح من الهاتف لتصوير المستندات ورفعها فقط
 * (كل صورة على حدة). القراءة بـ Claude أو Gemini تتم لاحقاً من الحاسوب من شاشة
 * "صور القيود"، والصورة تبقى محفوظة حتى ترحيل القيد.
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
            preview: null,
            image: null, // { data, mediaType }
            uploading: false,
            uploaded: null,
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
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = "";
        if (!file) {
            return;
        }
        this.state.uploaded = null;
        this.state.error = null;
        try {
            const dataUrl = await this.resize(file);
            this.state.preview = dataUrl;
            this.state.image = { data: dataUrl.split(",")[1], mediaType: "image/jpeg" };
        } catch {
            this.state.error = "تعذّر فتح الصورة. جرّب صورة أخرى.";
        }
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

    // لف الصورة قبل الرفع (90 = يميناً مع عقارب الساعة، -90 = يساراً)
    rotate(degrees) {
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
            this.state.preview = dataUrl;
            this.state.image = { data: dataUrl.split(",")[1], mediaType: "image/jpeg" };
        };
        source.src = this.state.preview;
    }

    async upload() {
        if (!this.state.image || this.state.uploading) {
            return;
        }
        this.state.uploading = true;
        this.state.error = null;
        try {
            this.state.uploaded = await this.orm.call("myaccounting.photo.entry", "upload_image",
                [this.state.image.data, this.state.image.mediaType]);
            this.state.image = null;
            this.state.preview = null;
            await this.loadInfo();
        } catch (error) {
            this.state.error = error.data?.message || error.message || "تعذّر رفع الصورة.";
        } finally {
            this.state.uploading = false;
        }
    }

    retake() {
        this.state.image = null;
        this.state.preview = null;
        this.openCamera();
    }

    nextPhoto() {
        this.state.uploaded = null;
        this.openCamera();
    }

    stateLabel(state) {
        return { new: "بانتظار القراءة", review: "بانتظار التأكيد" }[state] || state;
    }

    openEntry(id) {
        this.actionService.doAction({
            type: "ir.actions.act_window",
            res_model: "myaccounting.photo.entry",
            res_id: id,
            views: [[false, "form"]],
            target: "current",
        });
    }

    openList() {
        this.actionService.doAction("my_accounting.action_myaccounting_photo_entries");
    }
}

registry.category("actions").add("my_accounting.photo_capture", PhotoCapturePage);
