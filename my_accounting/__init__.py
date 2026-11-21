from . import models
from . import controllers


def post_init_hook(env):
    """يبني قوائم قوالب اليوميات تحت "قيد جديد" حسب القيود الموجودة."""
    env['myaccounting.move']._sync_journal_template_menus()
    # ومَن لا صفحةَ بدايةٍ له يبدأ من صفحة التطبيقات لا من المناقشة
    env['res.users']._set_home_to_app_launcher()
