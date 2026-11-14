package ai.agnowfm.timefold;

import ai.agnowfm.timefold.Domain.*;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Turns the engine's compiled problem (JSON) into a {@link Roster}. */
final class Builder {
    private Builder() {}

    static Roster build(JsonNode in) {
        JsonNode opts = in.get("options");
        int n = opts.size();
        int total = in.get("total").asInt();
        boolean wrap = in.path("wrap").asBoolean(false);
        JsonNode w = in.get("weights");
        long wUnder = w.path("under").asLong(), wOver = w.path("over").asLong(), wHeavy = Math.max(1, wOver / 3);
        JsonNode need = in.get("need");

        List<Pick> picks = new ArrayList<>(n + 1);
        Set<Integer> hint = new HashSet<>();
        for (JsonNode h : in.path("hint")) hint.add(h.asInt());
        boolean[] touched = new boolean[total];
        List<List<Term>> cover = new ArrayList<>(n), rows = new ArrayList<>(n), goals = new ArrayList<>(n), fair = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            JsonNode o = opts.get(i);
            Pick p = new Pick();
            p.idx = i;
            p.employee = o.get("employee").asInt();
            p.start = o.get("start").asInt();
            p.length = o.get("length").asInt();
            p.unitCost = o.path("unitCost").asLong();
            p.requireConsistency = o.path("requireConsistency").asBoolean(false);
            p.tolStart = 2 * in.path("startTol").asInt();
            p.tolEnd = 2 * in.path("endTol").asInt();
            p.chosen = hint.contains(i);
            List<Term> c = new ArrayList<>();
            int base = o.get("day").asInt() * 96;
            int a = base + p.start, b = a + p.length;
            int ga = o.path("gapSlots").asInt() > 0 ? base + o.path("gapStart").asInt() : 0, gb = ga + o.path("gapSlots").asInt();
            for (int g = a; g < (wrap ? Math.min(b, 2 * total) : Math.min(b, total)); g++) {
                if (g >= ga && g < gb && gb > ga) continue;                      // an unpaid meal or the gap of a split shift covers nothing
                int slot = g >= total ? g - total : g;
                c.add(new Term(slot, 1));
                touched[slot] = true;
            }
            cover.add(c);
            rows.add(new ArrayList<>());
            goals.add(new ArrayList<>());
            fair.add(new ArrayList<>());
            picks.add(p);
        }
        List<Row> rowFacts = new ArrayList<>();
        int r = 0;
        for (JsonNode row : in.path("rows")) {
            rowFacts.add(new Row(r, row.get("hi").asLong()));
            JsonNode c = row.get("c"), v = row.get("v");
            for (int k = 0; k < c.size(); k++) rows.get(c.get(k).asInt()).add(new Term(r, v.get(k).asLong()));
            r++;
        }
        List<Goal> goalFacts = new ArrayList<>();
        int gi = 0;
        for (JsonNode g : in.path("goals")) {
            goalFacts.add(new Goal(gi, g.get("target").asLong(), g.path("full").asBoolean(false), g.path("otBase").asLong(), w.path("hours").asLong(), w.path("overtime").asLong()));
            JsonNode c = g.get("c"), v = g.get("v");
            for (int k = 0; k < c.size(); k++) goals.get(c.get(k).asInt()).add(new Term(gi, v.get(k).asLong()));
            gi++;
        }
        List<Fair> fairFacts = new ArrayList<>();
        List<Term> fairZero = new ArrayList<>();
        JsonNode fp = in.path("fair");
        if (fp.has("people") && fp.get("people").size() > 1) {
            fairFacts.add(new Fair(fp.get("unit").asLong()));
            for (JsonNode person : fp.get("people")) {
                int e = person.get("employee").asInt();
                fairZero.add(new Term(e, person.path("prior").asLong()));
                JsonNode c = person.get("picks"), hrs = person.get("hours");
                for (int k = 0; k < c.size(); k++) fair.get(c.get(k).asInt()).add(new Term(e, hrs.get(k).asLong()));
            }
        }
        List<Slot> slots = new ArrayList<>();
        List<Term> coverZero = new ArrayList<>();
        for (int g = 0; g < total; g++) {
            int nd = g < need.size() ? need.get(g).asInt() : 0;
            if (nd > 0 || touched[g]) {
                slots.add(new Slot(g, nd, wUnder, wOver, wHeavy));
                coverZero.add(new Term(g, 0));
            }
        }
        // one pinned, always-chosen stand-in that carries a zero-weight term for every key, so that a key nobody real is chosen for still has a sum (zero) and its shortfall is charged;
        // for fairness its weight is each person's load already carried from the weeks solved before
        Pick dummy = new Pick();
        dummy.idx = n;
        dummy.dummy = true;
        dummy.pinned = true;
        dummy.chosen = true;
        dummy.cover = coverZero;
        List<Term> rowZero = new ArrayList<>();
        for (Row row : rowFacts) rowZero.add(new Term(row.id(), 0));
        dummy.rows = rowZero;
        List<Term> goalZero = new ArrayList<>();
        for (Goal g : goalFacts) goalZero.add(new Term(g.id(), 0));
        dummy.goals = goalZero;
        dummy.fair = fairZero;
        for (int i = 0; i < n; i++) {
            Pick p = picks.get(i);
            p.cover = cover.get(i);
            p.rows = rows.get(i);
            p.goals = goals.get(i);
            p.fair = fair.get(i);
        }
        picks.add(dummy);
        Roster roster = new Roster();
        roster.picks = picks;
        roster.rowFacts = rowFacts;
        roster.slotFacts = slots;
        roster.goalFacts = goalFacts;
        roster.fairFacts = fairFacts;
        return roster;
    }
}
