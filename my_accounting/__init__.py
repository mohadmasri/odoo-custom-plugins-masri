from . import models
from . import controllers


def post_init_hook(env):
    """يبني قوائم قوالب اليوميات تحت "قيد جديد" حسب القيود الموجودة."""
    env['myaccounting.move']._sync_journal_template_menus()
