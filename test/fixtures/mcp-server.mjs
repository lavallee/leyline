// A host's MCP server script, as a host would ship one: started by an agent, MCP on stdio.
// MCP_MODE=direct serves a small table itself; MCP_MODE=bridge passes calls on to the host
// that left a session file in MCP_STATE (see server/commands.mjs).
import { serveMcp, serveMcpBridge } from '../../server/mcp.mjs';

const tools = [
  { name: 'show', title: 'Show the draft', description: 'The draft as it is now.', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } },
  { name: 'edit', description: 'Replace text in the draft.', inputSchema: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } },
];
const served = process.env.MCP_MODE === 'bridge'
  ? serveMcpBridge({ app: 'testhost', name: process.env.MCP_SESSION, stateDir: process.env.MCP_STATE, tools, defaults: { page: process.env.MCP_PAGE }, server: { version: '1.2.3', instructions: 'Use show before edit.' } })
  : serveMcp({ name: 'direct', version: '0.0.1', tools, call: async (name, args) => {
    if (name === 'show') return { files: { 'draft.md': 'one two three' }, asked: args };
    if (args.find === 'missing') throw new Error('That text is not in the draft.');
    return `replaced ${args.find}`;
  } });
// When the agent closes the connection there is nothing left to do.
served.done.then(() => process.exit(0));
