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
    save: (items) => engine.save(items),
    delete: (ids) => engine.delete(ids),
    simulate: (termId, additions) => engine.simulate(termId, additions),
    store: engine.store,
  };

  const scope = { client, engine, console: customConsole };
  const scopeKeys = Object.keys(scope);
  const scopeValues = Object.values(scope);

  const trimmedCode = code.trim();
  let fnBody;
  if (!trimmedCode.includes("return ") && !trimmedCode.includes("const ") && !trimmedCode.includes("let ") && !trimmedCode.includes("var ")) {
    fnBody = `return (async () => { return (${trimmedCode}); })()`;
  } else if (!trimmedCode.includes("return ")) {
    fnBody = `return (async () => { ${trimmedCode} })()`;
  } else {
    fnBody = `return (async () => { ${trimmedCode} })()`;
  }

  try {
    const compiledFn = new Function(...scopeKeys, fnBody);
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
    { method: "client.query(opts)", desc: "Query schedule (from, to, catalogs, tz, returnEvents, mergeTasks, includeSimulation...)" },
    { method: "client.save(items)", desc: "Save terms, courses, activities, etc." },
    { method: "client.delete(ids)", desc: "Delete items by ID" },
    { method: "client.simulate(termId, additions)", desc: "Simulate additions on a term" },
    { method: "client.store", desc: "Access the raw SQLite store methods" },
  ];
  return { title: "Schedule Scripting API", docs };
}
