# /unilock

Human slash command. Dispatches without a model round trip.

This unit owns **only** the command plane. It does not call the CLI, load a
skill, register a tool, or open an MCP connection. A composition that wants
those behaviors adds the corresponding units; this command stays unchanged.

Input after `/unilock` is unstructured text, parsed by the command handler.
