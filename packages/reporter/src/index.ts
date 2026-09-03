export const PACKAGE_NAME = '@ael/reporter' as const;
export {
  buildReportSource,
  renderReportMarkdown,
  serializeReportJson,
  type ReportSource,
} from './report.js';
