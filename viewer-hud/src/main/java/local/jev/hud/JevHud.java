package local.jev.hud;
import com.google.gson.*;
import java.nio.file.*;
import java.util.concurrent.*;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;
import net.minecraft.util.Identifier;
import net.minecraft.client.util.ScreenshotRecorder;

/** Read-only display of the bot's actual client state; grants no game privileges. */
public class JevHud implements ClientModInitializer {
    private static volatile JsonObject state = new JsonObject();
    private static volatile boolean capture;
    public void onInitializeClient() {
        String file = System.getProperty("jev.hud.path");
        if (file == null) return;
        var poller = Executors.newSingleThreadScheduledExecutor(r -> { var t = new Thread(r, "jev-hud-reader"); t.setDaemon(true); return t; });
        poller.scheduleWithFixedDelay(() -> {
            try {
                state = JsonParser.parseString(Files.readString(Path.of(file))).getAsJsonObject();
                var request=Path.of(file).resolveSibling("hud-capture.request");
                if(Files.exists(request)) { Files.delete(request);capture=true; }
            }
            catch (Exception ignored) { state = new JsonObject(); }
        }, 0, 100, TimeUnit.MILLISECONDS);
    }
    private static String text(JsonObject o, String key, String fallback) {
        try { return o.get(key).getAsString(); } catch (Exception ignored) { return fallback; }
    }
    private static int number(JsonObject o, String key, int fallback) {
        try { return key.equals("health") ? (int)Math.ceil(o.get(key).getAsDouble()) : o.get(key).getAsInt(); } catch (Exception ignored) { return fallback; }
    }
    public static void render(DrawContext c) {
        var mc = MinecraftClient.getInstance();
        if (mc.player == null || !mc.player.isSpectator() || mc.options.hudHidden) return;
        JsonObject s = state;
        int x = c.getScaledWindowWidth()/2 - 91, y = c.getScaledWindowHeight()-25;
        boolean fresh;
        try { fresh = s.get("online").getAsBoolean() && System.currentTimeMillis()-s.get("at").getAsLong()<2000; }
        catch (Exception ignored) { fresh = false; }
        c.fill(x-4, y-26, x+186, y+23, 0xD010151C);
        String status = fresh ? "Jev  HP "+number(s,"health",0)+"/20  Food "+number(s,"food",0)+"/20" : "Jev offline / reconnecting";
        c.drawTextWithShadow(mc.textRenderer, status, x, y-22, 0xFFFFFF);
        c.drawTextWithShadow(mc.textRenderer, mc.textRenderer.trimToWidth(text(s,"activity","Observing"),182), x, y-11, 0xA8D8FF);
        JsonArray slots = s.has("slots") && s.get("slots").isJsonArray() ? s.getAsJsonArray("slots") : new JsonArray();
        for (int i=0;i<9;i++) {
            int sx=x+i*20;
            c.fill(sx,y,sx+19,y+20,0xFF555A62);
            c.fill(sx+1,y+1,sx+18,y+19,0xFF24282E);
            if (fresh && i==number(s,"selected",-1)) c.drawBorder(sx-1,y-1,21,22,0xFFFFFFFF);
            if (!fresh || i>=slots.size() || !slots.get(i).isJsonObject()) continue;
            try {
                JsonObject item=slots.get(i).getAsJsonObject();
                var id=Identifier.tryParse("minecraft:"+item.get("name").getAsString());
                if (id==null || !Registries.ITEM.containsId(id)) continue;
                var stack=new ItemStack(Registries.ITEM.get(id),item.get("count").getAsInt());
                c.drawItem(stack,sx+2,y+2);
                c.drawItemInSlot(mc.textRenderer,stack,sx+2,y+2);
            } catch (Exception ignored) { /* One unknown item must not break the spectator renderer. */ }
        }
        if(fresh && capture) {
            capture=false;
            c.draw();
            ScreenshotRecorder.saveScreenshot(mc.runDirectory,"jev-hud-verification.png",mc.getFramebuffer(),message -> System.out.println("Jev HUD verification screenshot saved"));
        }
    }
}
