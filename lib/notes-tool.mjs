// Same operations as the reading settings; this tool never changes archive policy implicitly.
import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerReadingNotes(ctx, operate) {
  return ctx.tools.register(defineTool({
    name: 'reading_notes',
    description: 'Manage reading annotations and their Markdown archive. Inspect status or list notes, configure the archive directory, export saved notes, or open the configured directory. Export rebuilds plugin-generated files and overwrites their manual edits; unrelated files are kept.',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'list', 'configure', 'export', 'open', 'add', 'remove'], description: 'Operation to perform.' },
      path: { type: 'string', description: 'For configure: absolute or ~/ archive directory, empty disables. For list/add/remove: book path.' },
      confirmOverwrite: { type: 'boolean', description: 'For export: set true only after the user explicitly agrees to overwrite manual edits in plugin-generated files. Omitted or false returns confirmationRequired without exporting. Ask the user before retrying; an export request alone is not overwrite consent.' },
      paragraph: { type: 'number', description: 'Zero-based paragraph index for add.' },
      quote: { type: 'string', description: 'Quoted passage for add (up to 400 characters).' },
      text: { type: 'string', description: 'Personal note text for add (up to 2000 characters).' },
      id: { type: 'string', description: 'Exact annotation ID for remove; also deletes its generated Markdown file.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.result }],
    },
    async execute(args) {
      const value = await operate(args)
      const text = JSON.stringify(value, null, 2)
      return { result: text.length > 16000 ? `${text.slice(0, 16000)}\n…（结果已截断，请按书路径查询）` : text }
    },
  }))
}
