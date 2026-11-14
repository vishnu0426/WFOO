package ai.agnowfm.timefold;

import ai.agnowfm.timefold.Domain.*;
import ai.timefold.solver.core.api.score.buildin.hardsoftlong.HardSoftLongScore;
import ai.timefold.solver.core.api.score.stream.Constraint;
import ai.timefold.solver.core.api.score.stream.ConstraintCollectors;
import ai.timefold.solver.core.api.score.stream.ConstraintFactory;
import ai.timefold.solver.core.api.score.stream.ConstraintProvider;
import ai.timefold.solver.core.api.score.stream.Joiners;

/**
 * The rules, as Timefold constraints. Hard: every limit the engine compiled (one shift a day, rest between shifts including across clock changes and groups, days in a row, hours and
 * days in a week, all counting what was worked elsewhere and before the period) and one usual start and end for people who must have them. Soft, in the engine's own units: people
 * short and surplus in each slot (and the extra price of a large surplus), a shift's own cost, contract hours short, planned overtime, and the spread of weekend and holiday time.
 */
public class Rules implements ConstraintProvider {

    @Override
    public Constraint[] defineConstraints(ConstraintFactory f) {
        return new Constraint[] {
            limits(f), consistency(f), under(f), over(f), heavy(f), shiftCostPositive(f), shiftCostNegative(f), contractShort(f), overtime(f), fairness(f),
        };
    }

    // ---- hard

    Constraint limits(ConstraintFactory f) {
        return f.forEach(Pick.class).filter(Pick::on).flattenLast(p -> p.rows)
                .groupBy(t -> t.key(), ConstraintCollectors.sumLong(t -> t.w()))
                .join(Row.class, Joiners.equal((k, s) -> k, Row::id))
                .filter((k, s, row) -> s > row.hi())
                .penalizeLong(HardSoftLongScore.ONE_HARD, (k, s, row) -> s - row.hi())
                .asConstraint("limits");
    }

    Constraint consistency(ConstraintFactory f) {
        return f.forEachUniquePair(Pick.class, Joiners.equal(p -> p.employee),
                        Joiners.filtering((a, b) -> a.on() && b.on() && a.requireConsistency && !a.dummy && !b.dummy
                                && (Math.abs(a.start - b.start) > a.tolStart || Math.abs((a.start + a.length) - (b.start + b.length)) > a.tolEnd)))
                .penalizeLong(HardSoftLongScore.ONE_HARD, (a, b) -> 1L)
                .asConstraint("one usual start and end");
    }

    // ---- soft: cover

    private static ai.timefold.solver.core.api.score.stream.bi.BiConstraintStream<Slot, Long> cover(ConstraintFactory f) {
        return f.forEach(Pick.class).filter(Pick::on).flattenLast(p -> p.cover)
                .groupBy(t -> t.key(), ConstraintCollectors.sumLong(t -> t.w()))
                .join(Slot.class, Joiners.equal((k, s) -> k, Slot::id))
                .map((k, s, slot) -> slot, (k, s, slot) -> s);
    }

    Constraint under(ConstraintFactory f) {
        return cover(f).filter((slot, n) -> n < slot.need())
                .penalizeLong(HardSoftLongScore.ONE_SOFT, (slot, n) -> slot.wUnder() * (slot.need() - n))
                .asConstraint("people short");
    }

    Constraint over(ConstraintFactory f) {
        return cover(f).filter((slot, n) -> n > slot.need())
                .penalizeLong(HardSoftLongScore.ONE_SOFT, (slot, n) -> slot.wOver() * (n - slot.need()))
                .asConstraint("surplus");
    }

    Constraint heavy(ConstraintFactory f) {
        return cover(f).filter((slot, n) -> n > 2L * slot.need() + 2)
                .penalizeLong(HardSoftLongScore.ONE_SOFT, (slot, n) -> slot.wHeavy() * (n - 2L * slot.need() - 2))
                .asConstraint("large surplus");
    }

    // ---- soft: the shift itself

    Constraint shiftCostPositive(ConstraintFactory f) {
        return f.forEach(Pick.class).filter(p -> p.on() && !p.dummy && p.unitCost > 0)
                .penalizeLong(HardSoftLongScore.ONE_SOFT, p -> p.unitCost).asConstraint("shift cost");
    }

    Constraint shiftCostNegative(ConstraintFactory f) {
        return f.forEach(Pick.class).filter(p -> p.on() && !p.dummy && p.unitCost < 0)
                .rewardLong(HardSoftLongScore.ONE_SOFT, p -> -p.unitCost).asConstraint("preferred shifts");
    }

    // ---- soft: contract hours and overtime

    private static ai.timefold.solver.core.api.score.stream.bi.BiConstraintStream<Goal, Long> paid(ConstraintFactory f) {
        return f.forEach(Pick.class).filter(Pick::on).flattenLast(p -> p.goals)
                .groupBy(t -> t.key(), ConstraintCollectors.sumLong(t -> t.w()))
                .join(Goal.class, Joiners.equal((k, s) -> k, Goal::id))
                .map((k, s, g) -> g, (k, s, g) -> s);
    }

    Constraint contractShort(ConstraintFactory f) {
        return paid(f).filter((g, s) -> g.wHours() > 0 && s < g.target())
                .penalizeLong(HardSoftLongScore.ONE_SOFT, (g, s) -> g.wHours() * (g.target() - s))
                .asConstraint("below contract hours");
    }

    Constraint overtime(ConstraintFactory f) {
        return paid(f).filter((g, s) -> g.wOvertime() > 0 && g.full() && s + g.otBase() > 0)
                .penalizeLong(HardSoftLongScore.ONE_SOFT, (g, s) -> g.wOvertime() * (s + g.otBase()))
                .asConstraint("overtime");
    }

    // ---- soft: fairness of weekend and holiday time

    Constraint fairness(ConstraintFactory f) {
        return f.forEach(Pick.class).filter(Pick::on).flattenLast(p -> p.fair)
                .groupBy(t -> t.key(), ConstraintCollectors.sumLong(t -> t.w()))
                .groupBy(ConstraintCollectors.max((Integer k, Long s) -> s), ConstraintCollectors.min((Integer k, Long s) -> s))
                .join(Fair.class)
                .penalizeLong(HardSoftLongScore.ONE_SOFT, (hi, lo, fair) -> fair.unit() * (hi - lo))
                .asConstraint("fair share of weekends and holidays");
    }
}
