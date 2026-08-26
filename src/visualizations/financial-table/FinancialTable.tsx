import { useMemo, useState, type CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import type { FinancialTableProjection } from "../../model-db/queries";
import type { Metric, Observation } from "../../model-db/types";

type Props = {
  projection: FinancialTableProjection;
  onSelectMetric: (metricId: string) => void;
  onSelectObservation: (observationId: string) => void;
};

function formatValue(value: Observation["value"], metric: Metric): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (metric.dataType === "percentage") {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: metric.dataType === "count" ? 0 : 1,
    maximumFractionDigits: metric.dataType === "count" ? 0 : 1,
  }).format(Math.abs(value));
  return value < 0 ? `(${formatted})` : formatted;
}

function valueTypeLabel(valueType: Observation["valueType"]): string {
  const labels: Record<Observation["valueType"], string> = {
    reported: "Reported",
    assumption: "Assumption",
    derived: "Derived",
    external_estimate: "External estimate",
  };
  return labels[valueType];
}

export function FinancialTable({
  projection,
  onSelectMetric,
  onSelectObservation,
}: Props) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const rows = useMemo(
    () =>
      normalizedSearch
        ? projection.rows.filter((row) =>
            [row.metric.name, row.metric.id, ...(row.metric.tags ?? [])]
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalizedSearch),
          )
        : projection.rows,
    [normalizedSearch, projection.rows],
  );

  const periodModes = projection.periods.map((period) => {
    const observation = projection.rows
      .map((row) => row.observations[period.id])
      .find(Boolean);
    return observation?.actuality ?? "estimate";
  });

  return (
    <div className="table-view" data-testid="financial-table-view">
      <header className="view-heading">
        <div>
          <span className="eyebrow">Dynamic projection</span>
          <h1>Financial table</h1>
          <p>
            Hierarchy comes from semantic relationships. Columns resolve the latest
            observation at or before {projection.model.asOf}.
          </p>
        </div>
        <div className="unit-key">
          <span>Presentation unit</span>
          <strong>{projection.model.baseCurrency} millions</strong>
        </div>
      </header>

      <div className="table-toolbar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search metric or tag"
            aria-label="Search metrics"
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search">
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <div className="table-legend" aria-label="Value type legend">
          <span><i className="value-dot reported" />Reported</span>
          <span><i className="value-dot assumption" />Assumption</span>
          <span><i className="value-dot derived" />Derived</span>
        </div>
      </div>

      <div className="financial-table-wrap">
        <table className="financial-table">
          <thead>
            <tr>
              <th className="metric-column">
                <span>Metric</span>
                <small>{rows.length} shown</small>
              </th>
              {projection.periods.map((period, index) => {
                const mode = periodModes[index];
                const boundary = index > 0 && periodModes[index - 1] !== mode;
                return (
                  <th
                    key={period.id}
                    className={`${mode} ${boundary ? "forecast-boundary" : ""}`}
                  >
                    <span>{period.label}</span>
                    <small>{mode === "actual" ? "Actual" : "Base est."}</small>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isDerived = Object.values(row.observations).some(
                (observation) => observation?.valueType === "derived",
              );
              return (
                <tr key={row.metric.id} className={row.depth === 0 ? "root-metric-row" : "child-metric-row"}>
                  <th scope="row" className="metric-column">
                    <button
                      className="metric-label-button"
                      onClick={() => onSelectMetric(row.metric.id)}
                      style={{ "--metric-depth": row.depth } as CSSProperties}
                    >
                      <span className="hierarchy-guide" />
                      <span className="metric-label-copy">
                        <strong>{row.metric.name}</strong>
                        <small>{row.metric.unit ?? row.metric.dataType}</small>
                      </span>
                      {isDerived && <span className="formula-badge">ƒx</span>}
                    </button>
                  </th>
                  {projection.periods.map((period, index) => {
                    const observation = row.observations[period.id];
                    const boundary = index > 0 && periodModes[index - 1] !== periodModes[index];
                    return (
                      <td
                        key={period.id}
                        className={`${periodModes[index]} ${boundary ? "forecast-boundary" : ""}`}
                      >
                        {observation ? (
                          <button
                            className={`value-button ${observation.valueType}`}
                            onClick={() => onSelectObservation(observation.id)}
                            title={`${valueTypeLabel(observation.valueType)} · ${observation.id}`}
                          >
                            <span>{formatValue(observation.value, row.metric)}</span>
                            <i className={`value-dot ${observation.valueType}`} />
                          </button>
                        ) : (
                          <span className="empty-value">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="empty-search">
            <Icon name="search" size={20} />
            No metric matches “{search}”.
          </div>
        )}
      </div>
      <footer className="table-footnote">
        <span>Click any number to inspect its source, formula, confidence, and review status.</span>
        <span>Values preserve raw precision; rounding is presentation-only.</span>
      </footer>
    </div>
  );
}
