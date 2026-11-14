package ai.agnowfm.timefold;

import ai.timefold.solver.core.api.domain.entity.PlanningEntity;
import ai.timefold.solver.core.api.domain.entity.PlanningPin;
import ai.timefold.solver.core.api.domain.lookup.PlanningId;
import ai.timefold.solver.core.api.domain.solution.PlanningEntityCollectionProperty;
import ai.timefold.solver.core.api.domain.solution.PlanningScore;
import ai.timefold.solver.core.api.domain.solution.PlanningSolution;
import ai.timefold.solver.core.api.domain.solution.ProblemFactCollectionProperty;
import ai.timefold.solver.core.api.domain.valuerange.ValueRangeProvider;
import ai.timefold.solver.core.api.domain.variable.PlanningVariable;
import ai.timefold.solver.core.api.score.buildin.hardsoftlong.HardSoftLongScore;

import java.util.List;

/**
 * The scheduling problem as Timefold sees it. The engine compiles its model into this shape: every candidate shift is a {@link Pick} that is either chosen or not; the rules and goals
 * that depend on a sum over picks are expressed as keyed weighted terms, so one set of constraints covers all of them.
 */
public final class Domain {
    private Domain() {}

    /** A weighted term of a sum: the sum is taken over every chosen pick, per key. */
    public record Term(int key, long w) {}

    /** At most `hi` in total over the chosen picks that carry a term with this key (a limit the engine compiled: one shift a day, rest, days in a row, hours and days in a week). */
    public record Row(int id, long hi) {}

    /** People needed in one slot of the period. */
    public record Slot(int id, int need, long wUnder, long wOver, long wHeavy) {}

    /** A person's paid time in one week against what the contract asks for: short of `target` is charged; beyond the contract (`otBase` + total above zero, when `full`) is overtime. */
    public record Goal(int id, long target, boolean full, long otBase, long wHours, long wOvertime) {}

    /** The price of an hour of difference in weekend and holiday time between the most and the least loaded person. */
    public record Fair(long unit) {}

    @PlanningEntity
    public static class Pick {
        @PlanningId
        public int idx;
        public int employee;
        public boolean dummy;                 // zero-weight stand-ins make sure every key has a sum, even when nothing real is chosen for it
        public boolean requireConsistency;    // this person must keep one usual start and end
        public int tolStart, tolEnd;          // how far apart their starts (and ends) may be: twice the tolerance in all
        public long unitCost;                 // what choosing this shift costs on its own (the engine's per-shift cost, preference and time past the end of the period)
        public int start, length;
        public List<Term> cover = List.of();  // slots it covers (weight 1)
        public List<Term> rows = List.of();   // limits it counts toward (weight = its coefficient)
        public List<Term> goals = List.of();  // weekly contract goals it counts toward (weight = paid slots)
        public List<Term> fair = List.of();   // unsocial hours it adds to its person's load
        @PlanningPin
        public boolean pinned;
        @PlanningVariable(valueRangeProviderRefs = "flag")
        public Boolean chosen;

        public Pick() {}

        public boolean on() { return chosen != null && chosen; }
    }

    @PlanningSolution
    public static class Roster {
        @ValueRangeProvider(id = "flag")
        public List<Boolean> flag = List.of(Boolean.FALSE, Boolean.TRUE);
        @ProblemFactCollectionProperty
        public List<Row> rowFacts = List.of();
        @ProblemFactCollectionProperty
        public List<Slot> slotFacts = List.of();
        @ProblemFactCollectionProperty
        public List<Goal> goalFacts = List.of();
        @ProblemFactCollectionProperty
        public List<Fair> fairFacts = List.of();
        @PlanningEntityCollectionProperty
        public List<Pick> picks = List.of();
        @PlanningScore
        public HardSoftLongScore score;

        public Roster() {}
    }
}
