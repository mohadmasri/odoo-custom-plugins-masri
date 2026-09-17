import logging

from odoo import models

_logger = logging.getLogger(__name__)

# قوائم الحزم (bundles) الحرجة لتشغيل صفحة الدخول والواجهة الخلفية. عند بدء
# تشغيل الخادم لأول مرة (بعد إعادة تشغيل الجهاز مثلاً)، إن وصل عدة طلبات HTTP
# متزامنة لنفس الحزمة غير المبنية بعد، يتسابقون على إنشائها في قاعدة البيانات
# فيفشل أحدهم بخطأ "SerializationFailure"، مما قد يُظهر صفحة بيضاء بعد تسجيل
# الدخول. نبني هذه الحزم هنا بشكل تسلسلي (بلا أي تزامن) فور اكتمال تحميل
# سجلّ النماذج (registry)، أي قبل استقبال أي طلب حقيقي من المتصفح، فلا يبقى
# هناك شيء يتسابق عليه المستخدمون لاحقاً.
_BUNDLES = [
    ('web.assets_frontend_minimal', True, False),
    ('web.assets_frontend', True, True),
    ('web.assets_web', True, True),
    ('web.assets_web_dark', False, True),
    ('web.assets_web_print', False, True),
]


class MyAccountingAssetWarmup(models.AbstractModel):
    _name = 'myaccounting.asset_warmup'
    _description = 'تسخين حزم الواجهة عند بدء تشغيل الخادم'

    def _register_hook(self):
        super()._register_hook()
        try:
            for name, want_js, want_css in _BUNDLES:
                bundle = self.env['ir.qweb']._get_asset_bundle(name, css=want_css, js=want_js)
                if want_js:
                    bundle.js()
                if want_css:
                    bundle.css()
            self.env.cr.commit()
        except Exception:
            _logger.exception('تعذّر تسخين حزم الواجهة عند بدء التشغيل')
            self.env.cr.rollback()
