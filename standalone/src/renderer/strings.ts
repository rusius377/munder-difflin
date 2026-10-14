import type { i18n as I18n } from 'i18next';

/** Strings of the standalone desk's own bottom bar (the trading screens bring theirs). */
const STRINGS: Record<string, Record<string, string>> = {
  ko: {
    appName: '트레이딩 데스크',
    language: '언어',
    claudeCommand: 'Claude 명령',
    claudeHint: 'LLM 제공자가 "Claude 구독"일 때 실행하는 Claude Code 명령입니다. 보통 claude 그대로 두면 됩니다. 찾지 못하면 전체 경로를 넣으세요.',
    save: '저장',
    saved: '저장했습니다',
    openData: '데이터 폴더'
  },
  en: {
    appName: 'Trading Desk',
    language: 'Language',
    claudeCommand: 'Claude command',
    claudeHint: 'The Claude Code command run when the LLM provider is "Claude subscription". Usually just claude; give the full path if it is not found.',
    save: 'Save',
    saved: 'Saved',
    openData: 'Data folder'
  },
  'zh-CN': {
    appName: '交易台',
    language: '语言',
    claudeCommand: 'Claude 命令',
    claudeHint: 'LLM 提供方为“Claude 订阅”时运行的 Claude Code 命令。通常保持 claude 即可；找不到时请填写完整路径。',
    save: '保存',
    saved: '已保存',
    openData: '数据文件夹'
  },
  ar: {
    appName: 'مكتب التداول',
    language: 'اللغة',
    claudeCommand: 'أمر Claude',
    claudeHint: 'أمر Claude Code الذي يُشغَّل عندما يكون مزوّد النموذج «اشتراك Claude». عادةً اتركه claude؛ وإن لم يُعثر عليه فأدخل المسار الكامل.',
    save: 'حفظ',
    saved: 'تم الحفظ',
    openData: 'مجلد البيانات'
  }
};

export function addDeskStrings(i18n: I18n): void {
  for (const [lng, s] of Object.entries(STRINGS)) i18n.addResourceBundle(lng, 'translation', { desk: s }, true, false);
}
