package local.jev.hud.mixin;
import local.jev.hud.JevHud;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.hud.InGameHud;
import net.minecraft.client.render.RenderTickCounter;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(InGameHud.class)
public class HudMixin {
    @Inject(method="render", at=@At("TAIL"))
    private void jevHud(DrawContext context, RenderTickCounter tickCounter, CallbackInfo ci) { JevHud.render(context); }
}
