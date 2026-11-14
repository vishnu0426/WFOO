package ai.agnowfm.timefold;

import ai.agnowfm.timefold.Domain.Pick;
import ai.agnowfm.timefold.Domain.Roster;
import ai.timefold.solver.core.api.score.buildin.hardsoftlong.HardSoftLongScore;
import ai.timefold.solver.core.api.solver.Solver;
import ai.timefold.solver.core.api.solver.SolverFactory;
import ai.timefold.solver.core.config.solver.SolverConfig;
import ai.timefold.solver.core.config.solver.termination.TerminationConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;

/**
 * Timefold Solver (Community Edition, Apache 2.0) as a service for the AgnoWFM engine.
 *   GET  /health        liveness
 *   GET  /capabilities  the scheduling rules this service implements. The engine only sends a request to a solver that implements every rule the request uses.
 *   POST /solve         the engine's compiled problem in, the chosen shifts out. The engine judges the answer with its own validator and scorer; nothing here is trusted.
 * Settings: PORT (8090), BIND (127.0.0.1), TIMEFOLD_TOKEN (when set, requests must carry it in X-Token), TIMEFOLD_MAX_BODY_MB (256), TIMEFOLD_MAX_SOLVES (1).
 */
public final class App {
    static final String VERSION = "timefold-solver-core 1.35.0 (Community Edition)";
    /** Rules implemented: the names the engine's capabilities.py uses. Not implemented here (and so never sent here): skills, consistency_preferred. */
    static final String[] RULES = {"wrap", "overtime", "fairness", "external_hours", "dst_rest", "gaps", "history", "option_cost", "consistency_required"};
    static final ObjectMapper JSON = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8090"));
        String bind = System.getenv().getOrDefault("BIND", "127.0.0.1");
        String token = System.getenv("TIMEFOLD_TOKEN");
        long maxBody = Long.parseLong(System.getenv().getOrDefault("TIMEFOLD_MAX_BODY_MB", "256")) * 1024 * 1024;
        Semaphore slots = new Semaphore(Integer.parseInt(System.getenv().getOrDefault("TIMEFOLD_MAX_SOLVES", "1")));
        HttpServer server = HttpServer.create(new InetSocketAddress(bind, port), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/health", ex -> reply(ex, 200, "{\"status\":\"ok\"}"));
        server.createContext("/capabilities", ex -> {
            ObjectNode o = JSON.createObjectNode();
            ArrayNode a = o.putArray("rules");
            for (String r : RULES) a.add(r);
            o.put("version", VERSION);
            reply(ex, 200, o.toString());
        });
        server.createContext("/solve", ex -> {
            try {
                if (!"POST".equals(ex.getRequestMethod())) { reply(ex, 405, "{\"error\":\"POST only\"}"); return; }
                if (token != null && !token.equals(ex.getRequestHeaders().getFirst("X-Token"))) { reply(ex, 401, "{\"error\":\"missing or wrong token\"}"); return; }
                String len = ex.getRequestHeaders().getFirst("Content-Length");
                if (len != null && Long.parseLong(len) > maxBody) { reply(ex, 413, "{\"error\":\"request too large\"}"); return; }
                if (!slots.tryAcquire()) { reply(ex, 503, "{\"error\":\"ENGINE_BUSY: a solve is already running\"}"); return; }
                try {
                    JsonNode in = JSON.readTree(ex.getRequestBody());
                    reply(ex, 200, solve(in).toString());
                } finally {
                    slots.release();
                }
            } catch (Exception e) {
                System.err.println("solve failed: " + e);
                reply(ex, 400, "{\"error\":" + JSON.writeValueAsString(String.valueOf(e.getMessage())) + "}");
            }
        });
        server.start();
        System.out.println("timefold service listening on " + bind + ":" + port + " (" + VERSION + ")");
    }

    static ObjectNode solve(JsonNode in) {
        Roster problem = Builder.build(in);
        long limit = Math.max(1, in.path("limitSec").asLong(10));
        SolverConfig cfg = new SolverConfig()
                .withEnvironmentMode(ai.timefold.solver.core.config.solver.EnvironmentMode.REPRODUCIBLE)
                .withSolutionClass(Roster.class).withEntityClasses(Pick.class).withConstraintProviderClass(Rules.class)
                .withTerminationConfig(new TerminationConfig().withSpentLimit(Duration.ofSeconds(limit)).withUnimprovedSpentLimit(Duration.ofSeconds(Math.max(3, limit / 3))));
        Solver<Roster> solver = SolverFactory.<Roster>create(cfg).buildSolver();
        Roster best = solver.solve(problem);
        HardSoftLongScore score = best.score;
        ObjectNode out = JSON.createObjectNode();
        ArrayNode chosen = out.putArray("chosen");
        for (Pick p : best.picks) if (!p.dummy && p.on()) chosen.add(p.idx);
        out.put("status", score.hardScore() == 0 ? "FEASIBLE" : "UNKNOWN");   // never claims OPTIMAL: local search proves nothing
        out.put("hard", score.hardScore());
        out.put("objective", -score.softScore());
        out.put("bound", 0);
        return out;
    }

    static void reply(HttpExchange ex, int code, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(code, b.length);
        try (var os = ex.getResponseBody()) { os.write(b); }
    }
}
