export const DOCUMENTED_TEMPLATE_VARIABLES = [
  'manifestDir',
  'suiteId',
  'fixtureId',
  'armId',
] as const;

export type DocumentedTemplateVariable = (typeof DOCUMENTED_TEMPLATE_VARIABLES)[number];

export type TemplateContext = Partial<Record<DocumentedTemplateVariable, string>>;

const DOCUMENTED_VARIABLE_SET = new Set<string>(DOCUMENTED_TEMPLATE_VARIABLES);

function isDocumentedVariable(name: string): name is DocumentedTemplateVariable {
  return DOCUMENTED_VARIABLE_SET.has(name);
}

export function interpolateTemplate(template: string, context: TemplateContext): string {
  let output = '';
  let index = 0;

  while (index < template.length) {
    const current = template.charAt(index);
    if (current !== '$') {
      output += current;
      index += 1;
      continue;
    }

    if (template[index + 1] === '{') {
      const closeIndex = template.indexOf('}', index + 2);
      if (closeIndex === -1) {
        output += template.slice(index);
        break;
      }

      const variableName = template.slice(index + 2, closeIndex);
      if (variableName.length === 0 || !isDocumentedVariable(variableName)) {
        output += template.slice(index, closeIndex + 1);
        index = closeIndex + 1;
        continue;
      }

      const replacement = context[variableName];
      if (replacement !== undefined) {
        output += replacement;
      } else {
        output += template.slice(index, closeIndex + 1);
      }

      index = closeIndex + 1;
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}
