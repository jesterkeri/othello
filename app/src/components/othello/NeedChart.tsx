'use client';

// Peak-need bars. npm i recharts
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export type NeedDatum = { r: string; need: number; label: string; over: boolean; peak: boolean };
type Props = { data: NeedDatum[]; reserve: number; reserveLabel: string; top: number; refusal: boolean };

const INK = '#0B0B0B';
const FONT = "var(--font-jakarta, 'Plus Jakarta Sans'), sans-serif";

export default function NeedChart({ data, reserve, reserveLabel, top, refusal }: Props) {
  const lineC = refusal ? 'var(--clay)' : INK;

  const Value = ({ x = 0, y = 0, width = 0, height = 0, value, index = 0 }: { x?: number; y?: number; width?: number; height?: number; value?: string; index?: number }) => {
    const d = data[index];
    const inside = height >= 26;
    const fill = !inside ? INK : d?.over ? 'var(--clayInk)' : d?.peak ? 'var(--acid)' : INK;
    return <text x={x + width / 2} y={inside ? y + 18 : y - 7} textAnchor="middle" fontFamily={FONT} fontSize={12} fontWeight={800} fill={fill}>{value}</text>;
  };

  const ReserveTag = ({ viewBox }: { viewBox?: { x: number; y: number; width: number } }) => {
    if (!viewBox) return null;
    const text = `reserve ${reserveLabel}`, w = text.length * 6.3 + 18, x = viewBox.x + viewBox.width - w;
    return (
      <g>
        <rect x={x} y={viewBox.y - 11} width={w} height={22} rx={11} fill={lineC} stroke={INK} strokeWidth={2} />
        <text x={x + w / 2} y={viewBox.y + 4} textAnchor="middle" fontFamily={FONT} fontSize={11} fontWeight={800} fill={refusal ? 'var(--clayInk)' : 'var(--acid)'}>{text}</text>
      </g>
    );
  };

  const Tip = ({ active, payload }: { active?: boolean; payload?: { payload: NeedDatum }[] }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]!.payload;
    return <div style={{ border: `2px solid ${INK}`, borderRadius: 12, background: '#fff', color: INK, padding: '6px 10px', font: `700 12px ${FONT}` }}>Round {d.r.slice(1)} · {d.label} USDC</div>;
  };

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 22, right: 4, bottom: 0, left: 4 }} barCategoryGap="18%">
        <XAxis dataKey="r" axisLine={{ stroke: INK, strokeWidth: 3 }} tickLine={false} tick={{ fill: INK, fontSize: 11, fontWeight: 800, fontFamily: FONT }} />
        <YAxis hide domain={[0, top]} />
        <Tooltip content={<Tip />} cursor={{ fill: 'rgba(11,11,11,.06)' }} />
        <ReferenceLine y={reserve} stroke={lineC} strokeWidth={3} strokeDasharray="8 6" ifOverflow="extendDomain" label={<ReserveTag />} />
        <Bar dataKey="need" radius={[12, 12, 0, 0]} stroke={INK} strokeWidth={2.5} isAnimationActive={false} minPointSize={3}>
          {data.map((d, i) => <Cell key={d.r} fill={d.over ? 'var(--clay)' : d.peak ? INK : 'var(--chip)'} />)}
          <LabelList dataKey="label" content={<Value />} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
