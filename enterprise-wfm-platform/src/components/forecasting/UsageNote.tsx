/** What depends on a forecast, in words: the schedules built on it. Shown before a forecast is withdrawn or deleted. */
import React from "react";

export type Usage = { schedules: { count: number; published: number; items: { id: string; name: string; status: string; from: string; to: string }[] } };

export const UsageNote: React.FC<{ usage: Usage | null; verb: string }> = ({ usage, verb }) => {
  if (!usage) return null;
  const { count, published, items } = usage.schedules;
  if (count === 0) return <p className="mt-2 text-[#6B6B6B]">No schedule was built on it.</p>;
  return (
    <div className="mt-2 rounded-md border border-[#E9D9B4] bg-[#FFF8E6] p-2.5 text-[12px]">
      <div className="font-medium text-[#8F6200]">{count} {count === 1 ? "schedule was" : "schedules were"} built on it{published ? `, ${published} published` : ""}.</div>
      <p className="mt-0.5 text-[#6B6B6B]">They keep their shifts. After you {verb} it, they have no forecast to follow and show as out of date.</p>
      <ul className="mt-1 list-disc pl-4">{items.slice(0, 5).map((x) => <li key={x.id}>{x.name} <span className="text-[#6B6B6B]">· {x.status.toLowerCase()}</span></li>)}{count > 5 && <li className="list-none text-[#6B6B6B]">and {count - 5} more</li>}</ul>
    </div>
  );
};
