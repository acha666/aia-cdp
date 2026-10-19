// @ts-expect-error -- process must not exist in the Worker program
export type NodeLeak = typeof process;
