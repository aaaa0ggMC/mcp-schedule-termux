export function compileScript(code, scopeKeys) {
  const trimmed = code.trim();
  try {
    return new Function(...scopeKeys, `return (async () => (${trimmed}))()`);
  } catch {
    return new Function(...scopeKeys, `return (async () => { ${trimmed} })()`);
  }
}

export async function runScript(engine, code) {
  const startTime = Date.now();
  const logs = [];
  const customConsole = {
    log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")),
    info: (...args) => logs.push("[INFO] " + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")),
    warn: (...args) => logs.push("[WARN] " + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")),
    error: (...args) => logs.push("[ERROR] " + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(" ")),
  };

  const client = {
    query: (opts) => engine.query(opts),
    mutate: (input) => engine.mutate(input),
    import: (input) => engine.import(input),
    plan: (input) => engine.plan(input),
    store: engine.store,
  };

  const scope = { client, engine, console: customConsole };
  const scopeKeys = Object.keys(scope);
  const scopeValues = Object.values(scope);

  try {
    const compiledFn = compileScript(code, scopeKeys);
    const rawResult = await compiledFn(...scopeValues);
    return {
      success: true,
      result: rawResult !== undefined ? rawResult : (logs.length > 0 ? logs.join("\n") : "Script executed successfully"),
      logs,
      executionTimeMs: Date.now() - startTime
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
      logs,
      executionTimeMs: Date.now() - startTime
    };
  }
}

export function scriptingMan(options = {}) {
  const docs = [
    { method: "client.query(opts)", desc: "Read the timetable. opts: from, to, timezone, dayStart/dayEnd, views, returnEvents, mergeTasks, includeSimulation..." },
    { method: "client.mutate({ operations, dryRun })", desc: "Write. Operations: put, patch, enable, set_timetable, switch_timetable; dryRun previews without committing" },
    { method: "client.import({ namespace, entries, dryRun })", desc: "Import external entries; every entry needs source.key" },
    { method: "client.plan({ from, to, tasks, newTasks, commit })", desc: "Lay out tasks into free slots; commit=false previews the blocks" },
    { method: "client.store", desc: "Raw SQLite store: revision(), history(), ..." },
    { method: "engine", desc: "The engine instance behind client, for the same query/mutate/import/plan methods" },
  ];
  if (options.query) {
    const q = String(options.query).toLowerCase();
    return docs.filter((d) => d.method.toLowerCase().includes(q) || d.desc.toLowerCase().includes(q));
  }
  return { title: "Schedule Scripting API", docs };
}
