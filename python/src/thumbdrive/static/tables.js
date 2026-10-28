/* Thumbdrive tables grid (no inline script; strict CSP). Uses the vendored Tabulator 6.7.1 (MIT).
 * Every change is sent to the draft as JSON with the page's CSRF token (X-CSRF-Token header);
 * the server validates and returns each touched row with its per-cell errors, shown in red.
 * Ported from the TypeScript edition's tables.js; keep the two in step. */
(function () {
  "use strict";

  // Single-select columns: show the choices box only for that type.
  document.querySelectorAll("[data-type-select]").forEach(function (sel) {
    var form = sel.closest("form");
    var field = form && form.querySelector("[data-options-field]");
    if (!field) return;
    var sync = function () {
      field.hidden = sel.value !== "select";
    };
    sel.addEventListener("change", sync);
    sync();
  });

  var host = document.getElementById("grid");
  if (!host || typeof window.Tabulator !== "function") return;
  var csrfMeta = document.querySelector('meta[name="csrf"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute("content") : "";
  var statusEl = document.querySelector("[data-grid-status]");
  var addBtn = document.querySelector("[data-grid-add]");
  var delBtn = document.querySelector("[data-grid-delete]");
  var clearBtn = document.querySelector("[data-grid-clear-filters]");
  var countsEl = document.querySelector("[data-diff-counts]");
  var meta = null;
  var table = null;

  function setStatus(text, bad) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("bad", !!bad);
  }

  function post(url, body) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json", "x-csrf-token": csrf },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r
        .json()
        .catch(function () {
          return { error: "Unexpected response (" + r.status + ")" };
        })
        .then(function (j) {
          if (!r.ok) throw new Error(j.error || "Request failed (" + r.status + ")");
          return j;
        });
    });
  }

  function toRow(r) {
    var o = { _id: r.id, _errors: r.errors || {} };
    meta.columns.forEach(function (c) {
      var v = r.data[c.id];
      o[c.id] = v === undefined ? (c.type === "checkbox" ? false : null) : v;
    });
    return o;
  }

  function badge(cls, text) {
    var s = document.createElement("span");
    s.className = "badge " + cls;
    s.textContent = text;
    return s;
  }

  function showSummary(s) {
    if (!s) return;
    if (countsEl) {
      countsEl.textContent = "";
      countsEl.appendChild(badge("ok", "+" + s.added + " added"));
      countsEl.appendChild(document.createTextNode(" "));
      countsEl.appendChild(badge("accent", "~" + s.changed + " changed"));
      countsEl.appendChild(document.createTextNode(" "));
      countsEl.appendChild(badge("danger", "\u2212" + s.removed + " removed"));
      if (s.columns) {
        countsEl.appendChild(document.createTextNode(" "));
        countsEl.appendChild(badge("", s.columns + " column change" + (s.columns === 1 ? "" : "s")));
      }
    }
    setStatus(
      s.issues
        ? "Saved to draft. " + s.issues + " problem" + (s.issues === 1 ? "" : "s") + " to fix before publishing (red cells)."
        : "Saved to draft." + (s.added + s.changed + s.removed + s.columns ? " Ready to publish." : ""),
      s.issues > 0,
    );
  }

  // ---------- sorting helpers ----------

  function ipKey(s) {
    if (s == null || s === "") return "";
    s = String(s);
    if (s.indexOf(":") >= 0) return "~" + s;
    var parts = s.split("/");
    var o = parts[0].split(".").map(function (x) {
      return ("000" + x).slice(-3);
    });
    return o.join(".") + "/" + ("00" + (parts[1] || "32")).slice(-3);
  }
  function ipSorter(a, b) {
    var x = ipKey(a),
      y = ipKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // ---------- columns ----------

  function textNode(v, err) {
    var span = document.createElement("span");
    span.textContent = v == null ? "" : String(v);
    if (err) {
      var mark = document.createElement("span");
      mark.className = "bad-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "!";
      span.insertBefore(mark, span.firstChild);
      var sr = document.createElement("span");
      sr.className = "sr-only";
      sr.textContent = " (invalid: " + err + ")";
      span.appendChild(sr);
    }
    return span;
  }

  /** Marks a cell red when its row's _errors names the column, and returns its content node. */
  function paint(cell, c) {
    var el = cell.getElement();
    var errs = cell.getRow().getData()._errors || {};
    var err = errs[c.id];
    el.classList.toggle("cell-bad", !!err);
    if (err) {
      el.setAttribute("title", err);
      el.setAttribute("aria-invalid", "true");
    } else {
      el.removeAttribute("title");
      el.removeAttribute("aria-invalid");
    }
    var v = cell.getValue();
    if (c.type === "checkbox") return textNode(v === true ? "\u2713" : "", err);
    return textNode(v, err);
  }

  /** Error flags live in _errors, not in an edited field, so Tabulator will not rerun formatters; repaint directly. */
  function repaint(row) {
    row.getCells().forEach(function (cell) {
      var field = cell.getField();
      var c = meta.columns.filter(function (x) {
        return x.id === field;
      })[0];
      var el = cell.getElement();
      if (!c || el.classList.contains("tabulator-editing")) return;
      el.replaceChildren(paint(cell, c));
    });
  }

  function colDef(c) {
    var def = {
      title: c.name + (meta.keyColumn === c.id ? " \u2605" : ""),
      field: c.id,
      minWidth: 110,
      maxWidth: c.type === "longtext" ? 420 : 320,
      headerFilter: "input",
      headerFilterPlaceholder: "Filter",
      headerTooltip: c.name + " (" + typeName(c.type) + ")" + (meta.keyColumn === c.id ? ", key column" : ""),
      editor: "input",
      formatter: function (cell) {
        return paint(cell, c);
      },
    };
    if (c.type === "longtext") def.editor = "textarea";
    if (c.type === "number") def.sorter = "number";
    if (c.type === "ip" || c.type === "cidr") def.sorter = ipSorter;
    if (c.type === "checkbox") {
      def.editor = "tickCross";
      def.hozAlign = "center";
      def.headerFilter = "tickCross";
      def.headerFilterParams = { tristate: true };
      def.headerFilterEmptyCheck = function (v) {
        return v === null || v === undefined || v === "";
      };
      def.minWidth = 80;
    }
    if (c.type === "select") {
      def.editor = "list";
      def.editorParams = { values: c.options || [], clearable: true, autocomplete: true, listOnEmpty: true, freetext: false };
    }
    return def;
  }

  function typeName(t) {
    var hit = (meta.types || []).filter(function (x) {
      return x.id === t;
    })[0];
    return hit ? hit.label : t;
  }

  // ---------- saving ----------

  var pending = {};
  var timer = null;
  function queue(rowId, field, value) {
    if (value === "") value = null;
    (pending[rowId] = pending[rowId] || {})[field] = value;
    setStatus("Saving\u2026");
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  }
  function flush() {
    var updates = Object.keys(pending).map(function (id) {
      return { row: Number(id), values: pending[id] };
    });
    pending = {};
    if (!updates.length) return;
    send({ updates: updates });
  }
  function send(edits) {
    setStatus("Saving\u2026");
    return post(host.dataset.edits, edits)
      .then(function (res) {
        if (res.rows.length) {
          table.updateOrAddData(res.rows.map(toRow)).then(function (rows) {
            rows.forEach(repaint);
          });
        }
        if (res.deleted && res.deleted.length) table.deleteRow(res.deleted);
        showSummary(res.summary);
        return res;
      })
      .catch(function (err) {
        setStatus("Not saved: " + err.message + " Reloading the draft\u2026", true);
        return load();
      });
  }

  // ---------- range helpers ----------

  function editing() {
    var a = document.activeElement;
    return !!(a && host.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function rangeCells() {
    var ranges = table.getRanges ? table.getRanges() : [];
    var out = [];
    ranges.forEach(function (r) {
      (r.getCells() || []).forEach(function (x) {
        if (Array.isArray(x)) out.push.apply(out, x);
        else out.push(x);
      });
    });
    return out.filter(function (cell) {
      return cell && cell.getField && cell.getField() !== "_id";
    });
  }
  function fields() {
    return meta.columns.map(function (c) {
      return c.id;
    });
  }
  function visibleFields() {
    return table
      .getColumns()
      .map(function (col) {
        return col.getField();
      })
      .filter(function (f) {
        return f && f !== "_id";
      });
  }
  function colById(id) {
    return meta.columns.filter(function (c) {
      return c.id === id;
    })[0];
  }

  function clearCells() {
    var cells = rangeCells();
    if (!cells.length) return;
    var updates = {};
    cells.forEach(function (cell) {
      var id = cell.getRow().getData()._id;
      (updates[id] = updates[id] || {})[cell.getField()] = null;
    });
    send({
      updates: Object.keys(updates).map(function (id) {
        return { row: Number(id), values: updates[id] };
      }),
    });
  }

  function parseClip(text) {
    // Tab-separated (Excel / Sheets), with quoted cells that may hold newlines.
    var rows = [];
    var row = [];
    var cell = "";
    var q = false;
    text = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') q = false;
        else cell += ch;
      } else if (ch === '"' && cell === "") q = true;
      else if (ch === "\t") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n") {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      } else cell += ch;
    }
    row.push(cell);
    rows.push(row);
    return rows;
  }

  function onPaste(e) {
    if (editing() || !table) return;
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (!text) return;
    e.preventDefault();
    var cells = rangeCells();
    if (!cells.length) {
      // No anchor: append (the server maps a header row by column name).
      setStatus("Pasting\u2026");
      post(host.dataset.paste, { text: text })
        .then(function (res) {
          table.replaceData(res.rows.map(toRow));
          showSummary(res.summary);
          setStatus("Pasted: " + res.added + " added, " + res.updated + " updated. " + (statusEl ? statusEl.textContent : ""), res.invalid > 0);
        })
        .catch(function (err) {
          setStatus("Paste failed: " + err.message, true);
        });
      return;
    }
    var grid = parseClip(text);
    var cols = visibleFields();
    var rows = table.getRows("active");
    var ids = rows.map(function (r) {
      return r.getData()._id;
    });
    // Anchor at the top-left selected cell.
    var top = Infinity,
      left = Infinity;
    cells.forEach(function (cell) {
      top = Math.min(top, ids.indexOf(cell.getRow().getData()._id));
      left = Math.min(left, cols.indexOf(cell.getField()));
    });
    if (grid.length === 1 && grid[0].length === 1) {
      // One value into every selected cell.
      var fill = {};
      cells.forEach(function (cell) {
        var id = cell.getRow().getData()._id;
        (fill[id] = fill[id] || {})[cell.getField()] = grid[0][0] === "" ? null : grid[0][0];
      });
      send({
        updates: Object.keys(fill).map(function (id) {
          return { row: Number(id), values: fill[id] };
        }),
      });
      return;
    }
    var updates = [];
    var adds = [];
    grid.forEach(function (line, r) {
      var values = {};
      line.forEach(function (v, k) {
        var f = cols[left + k];
        if (!f) return;
        var col = colById(f);
        if (col && col.type === "checkbox") values[f] = /^(1|y|yes|true|x|\u2713)$/i.test(v.trim());
        else values[f] = v === "" ? null : v;
      });
      var idx = top + r;
      if (idx < ids.length) updates.push({ row: ids[idx], values: values });
      else adds.push({ values: values });
    });
    send({ updates: updates, adds: adds }).then(function (res) {
      if (res && res.added && res.added.length) setStatus("Pasted " + grid.length + " row(s); " + res.added.length + " added at the end. " + statusEl.textContent);
    });
  }

  // ---------- build ----------

  function build(data) {
    meta = data.table;
    meta.types = data.types;
    if (table) table.destroy();
    if (!meta.columns.length) {
      setStatus("Add a column to start.");
      return;
    }
    table = new window.Tabulator(host, {
      data: data.rows.map(toRow),
      index: "_id",
      layout: "fitDataStretch",
      height: "min(70vh, 640px)",
      placeholder: "No rows yet. Add a row, or paste rows copied from Excel.",
      selectableRange: 1,
      selectableRangeColumns: true,
      selectableRangeRows: true,
      selectableRangeClearCells: false,
      editTriggerEvent: "dblclick",
      clipboard: "copy",
      clipboardCopyRowRange: "range",
      clipboardCopyConfig: { columnHeaders: false, columnGroups: false, rowHeaders: false },
      rowHeader: {
        title: "#",
        field: "_id",
        headerSort: true,
        sorter: "number",
        frozen: true,
        resizable: false,
        width: 64,
        hozAlign: "right",
        headerTooltip: "Row id (never reused). Click a row number to select the row.",
      },
      columns: meta.columns.map(colDef),
    });
    // The reason for a red cell is in its title; also show it in the status line on click.
    table.on("cellClick", function (e, cell) {
      var err = (cell.getRow().getData()._errors || {})[cell.getField()];
      if (err) setStatus(cell.getColumn().getDefinition().title.replace(" \u2605", "") + ": " + err, true);
    });
    table.on("cellEdited", function (cell) {
      queue(cell.getRow().getData()._id, cell.getField(), cell.getValue());
    });
    table.on("tableBuilt", function () {
      if (addBtn) addBtn.disabled = false;
      if (delBtn) delBtn.disabled = false;
      // The focusable scroll holder sits between role=grid and its rows; make it the
      // rowgroup (and the inner table presentational) so the ARIA grid structure stays valid.
      var holder = host.querySelector(".tabulator-tableholder");
      var body = host.querySelector(".tabulator-tableholder > .tabulator-table");
      if (holder && body) {
        holder.setAttribute("role", "rowgroup");
        holder.setAttribute("aria-label", "Rows");
        body.setAttribute("role", "presentation");
      }
      showSummary(data.summary);
      setStatus(data.rows.length + " draft row" + (data.rows.length === 1 ? "" : "s") + ". " + statusEl.textContent, data.summary.issues > 0);
    });
  }

  function load() {
    return fetch(host.dataset.src, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Could not load the draft (" + r.status + ")");
        return r.json();
      })
      .then(build)
      .catch(function (err) {
        setStatus(err.message, true);
      });
  }

  host.addEventListener("keydown", function (e) {
    if (!table || editing()) return;
    // An Enter that just committed an editor bubbles here after the editor closed; do not reopen it.
    var tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Enter" || e.key === "F2") {
      var cells = rangeCells();
      if (cells.length) {
        e.preventDefault();
        cells[0].edit(true);
      }
    } else if (e.key === "Delete" || e.key === "Backspace") {
      if (rangeCells().length) {
        e.preventDefault();
        clearCells();
      }
    }
  });
  host.addEventListener("paste", onPaste);

  if (addBtn)
    addBtn.addEventListener("click", function () {
      if (!table) return;
      send({ adds: [{ values: {} }] }).then(function (res) {
        var added = res && res.added && res.added[0];
        if (!added) return;
        var first = fields()[0];
        // Edit only once the new row is rendered; editing a virtual (unrendered) cell breaks Tabulator's cancel.
        table
          .scrollToRow(added.id, "bottom", false)
          .catch(function () {})
          .then(function () {
            var row = table.getRow(added.id);
            var cell = row && first && row.getCell(first);
            if (cell && cell.getElement() && cell.getElement().isConnected) cell.edit(true);
          });
      });
    });
  if (delBtn)
    delBtn.addEventListener("click", function () {
      if (!table) return;
      var ids = {};
      rangeCells().forEach(function (cell) {
        ids[cell.getRow().getData()._id] = true;
      });
      var list = Object.keys(ids).map(Number);
      if (!list.length) {
        setStatus("Select a cell in each row to delete (click a row number to select the row).", true);
        return;
      }
      if (!window.confirm("Delete " + list.length + " row" + (list.length === 1 ? "" : "s") + " from the draft? Published versions keep them.")) return;
      send({ deletes: list });
    });
  if (clearBtn)
    clearBtn.addEventListener("click", function () {
      if (table) {
        table.clearHeaderFilter();
        table.clearSort();
      }
    });

  load();
})();
