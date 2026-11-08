// Freestanding WebAssembly kernel for the native airbrush patch.
using Pair = double __attribute__((vector_size(16)));

static double minimum(double a, double b) { return a < b ? a : b; }
static double maximum(double a, double b) { return a > b ? a : b; }
static double lightness(Pair rg, double b) { return rg[0] * .3 + rg[1] * .59 + b * .11; }

static Pair falloff_exp(Pair q) {
    // The reduced argument is in [-.28125, 0]. The Taylor remainder after
    // twelve terms stays below a double's rounding error after four squarings.
    const Pair x = q * q * (-4.5 / 16.);
    constexpr double terms[] = {1., 1., 1. / 2., 1. / 6., 1. / 24., 1. / 120.,
        1. / 720., 1. / 5040., 1. / 40320., 1. / 362880., 1. / 3628800., 1. / 39916800.};
    Pair value = {1. / 479001600., 1. / 479001600.};
    #pragma clang loop unroll(full)
    for (int term = 11; term >= 0; --term) value = terms[term] + x * value;
    for (int step = 0; step < 4; ++step) value *= value;
    return value;
}

extern "C" void add_dab_region(float *coverage, int stride, int left, int top, int right, int bottom,
                               double cx, double cy, double radius, double hardness, double flow) {
    constexpr double edge = .011108996538242306;
    const double feather = maximum(1 - hardness, 1e-6);
    const double radius_squared = radius * radius;
    for (int y = top; y < bottom; ++y) {
        const double dy = y + .5 - cy;
        if (__builtin_fabs(dy) > radius + 1) continue;
        const double row_extent = __builtin_sqrt(maximum(0, radius_squared - dy * dy)) + 1;
        const int candidate_left = static_cast<int>(__builtin_floor(cx - row_extent - .5));
        const int candidate_right = static_cast<int>(__builtin_ceil(cx + row_extent - .5) + 1);
        const int row_left = left > candidate_left ? left : candidate_left;
        const int row_right = right < candidate_right ? right : candidate_right;
        for (int x = row_left; x < row_right; x += 2) {
            const Pair dx = {x + .5 - cx, x + 1.5 - cx};
            const Pair length = dx * dx + dy * dy;
            const Pair distance = {__builtin_sqrt(length[0]) / radius, __builtin_sqrt(length[1]) / radius};
            const Pair q = {maximum(0, minimum(1, (distance[0] - hardness) / feather)),
                            maximum(0, minimum(1, (distance[1] - hardness) / feather))};
            const Pair amount = q[0] == 0 && q[1] == 0 ? Pair{1, 1} : (falloff_exp(q) - edge) / (1 - edge);
            for (int lane = 0; lane < 2 && x + lane < row_right; ++lane) {
                if (distance[lane] >= 1) continue;
                float &pixel = coverage[y * stride + x + lane];
                pixel += (1. - pixel) * maximum(0, amount[lane]) * flow;
            }
        }
    }
}

extern "C" void add_dab(float *coverage, int width, int height, double cx, double cy,
                        double radius, double hardness, double flow) {
    add_dab_region(coverage, width, 0, 0, width, height, cx, cy, radius, hardness, flow);
}

static unsigned char to_byte(double channel) {
    return static_cast<unsigned char>(maximum(0, minimum(255, channel * 255 + .5)));
}

static double soft_light(double base, double brush) {
    if (brush <= .5) return base - (1 - 2 * brush) * base * (1 - base);
    const double curve = base <= .25 ? ((16 * base - 12) * base + 4) * base : __builtin_sqrt(base);
    return base + (2 * brush - 1) * (curve - base);
}

static void color_blend(Pair &rg, double &b, double light, double brush_light) {
    rg = rg + light - brush_light;
    b = b + light - brush_light;
    const double lum = lightness(rg, b);
    const double low = minimum(minimum(rg[0], rg[1]), b);
    if (low < 0) {
        const double denominator = maximum(lum - low, 1e-6);
        rg = lum + (rg - lum) * lum / denominator;
        b = lum + (b - lum) * lum / denominator;
    }
    const double high = maximum(maximum(rg[0], rg[1]), b);
    if (high > 1) {
        const double denominator = maximum(high - lum, 1e-6);
        rg = lum + (rg - lum) * (1 - lum) / denominator;
        b = lum + (b - lum) * (1 - lum) / denominator;
    }
    rg = {maximum(0, minimum(1, rg[0])), maximum(0, minimum(1, rg[1]))};
    b = maximum(0, minimum(1, b));
}

template<int Mode>
static void blend(unsigned char *rgba, const float *coverage, unsigned count,
                  unsigned rgb, double stroke_opacity, double layer_opacity) {
    const Pair brush = {(rgb >> 16) / 255., ((rgb >> 8) & 255) / 255.};
    const double brush_b = (rgb & 255) / 255.;
    const double brush_light = lightness(brush, brush_b);
    for (unsigned i = 0; i < count; ++i, rgba += 4) {
        const unsigned coverage_byte = static_cast<unsigned>(coverage[i] * 255. + .5);
        if (!coverage_byte) continue;
        const double weight = coverage_byte / 255. * stroke_opacity * layer_opacity;
        const Pair base = {rgba[0] / 255., rgba[1] / 255.};
        const double base_b = rgba[2] / 255.;
        Pair changed = brush;
        double changed_b = brush_b;
        if constexpr (Mode == 1) {
            changed = {soft_light(base[0], brush[0]), soft_light(base[1], brush[1])};
            changed_b = soft_light(base_b, brush_b);
        }
        if constexpr (Mode == 2) color_blend(changed, changed_b, lightness(base, base_b), brush_light);
        if constexpr (Mode == 3) {
            changed = base * brush;
            changed_b = base_b * brush_b;
        }
        if constexpr (Mode == 4) {
            changed = 1 - (1 - base) * (1 - brush);
            changed_b = 1 - (1 - base_b) * (1 - brush_b);
        }
        const Pair result = base + (changed - base) * weight;
        rgba[0] = to_byte(result[0]);
        rgba[1] = to_byte(result[1]);
        rgba[2] = to_byte(base_b + (changed_b - base_b) * weight);
    }
}

template<int Mode>
static void blend_region(unsigned char *rgba, const float *coverage, unsigned rgba_width,
                         unsigned left, unsigned top, unsigned stride, unsigned width, unsigned height,
                         unsigned rgb, double stroke_opacity, double layer_opacity) {
    for (unsigned y = 0; y < height; ++y) {
        blend<Mode>(rgba + y * rgba_width * 4,
                    coverage + (top + y) * stride + left,
                    width, rgb, stroke_opacity, layer_opacity);
    }
}

static void blend_large_normal_region(unsigned char *rgba, const float *coverage, unsigned rgba_width,
                                      unsigned left, unsigned top, unsigned stride, unsigned width, unsigned height,
                                      unsigned rgb, double stroke_opacity, double layer_opacity) {
    // Normal mode depends only on one source channel and the quantized coverage.
    // Share the exact mapping across all tiles and dabs with these brush settings.
    static unsigned char table[3][256][256];
    static unsigned previous_rgb = ~0u;
    static double previous_stroke_opacity, previous_layer_opacity;
    if (rgb != previous_rgb || stroke_opacity != previous_stroke_opacity || layer_opacity != previous_layer_opacity) {
        previous_rgb = rgb;
        previous_stroke_opacity = stroke_opacity;
        previous_layer_opacity = layer_opacity;
        for (unsigned c = 0; c < 3; ++c) {
            const double brush = ((rgb >> (16 - c * 8)) & 255) / 255.;
            for (unsigned strength = 1; strength < 256; ++strength) {
                const double weight = strength / 255. * stroke_opacity * layer_opacity;
                for (unsigned value = 0; value < 256; ++value) {
                    const double base = value / 255.;
                    table[c][strength][value] = to_byte(base + (brush - base) * weight);
                }
            }
        }
    }
    for (unsigned y = 0; y < height; ++y) {
        unsigned char *row = rgba + y * rgba_width * 4;
        const float *weights = coverage + (top + y) * stride + left;
        for (unsigned x = 0; x < width; ++x, row += 4) {
            const unsigned strength = static_cast<unsigned>(weights[x] * 255. + .5);
            if (!strength) continue;
            row[0] = table[0][strength][row[0]];
            row[1] = table[1][strength][row[1]];
            row[2] = table[2][strength][row[2]];
        }
    }
}

extern "C" void blend_rgba(unsigned char *rgba, const float *coverage, unsigned count,
                            unsigned rgb, double stroke_opacity, double layer_opacity, int mode) {
    switch (mode) {
        case 1: blend<1>(rgba, coverage, count, rgb, stroke_opacity, layer_opacity); break;
        case 2: blend<2>(rgba, coverage, count, rgb, stroke_opacity, layer_opacity); break;
        case 3: blend<3>(rgba, coverage, count, rgb, stroke_opacity, layer_opacity); break;
        case 4: blend<4>(rgba, coverage, count, rgb, stroke_opacity, layer_opacity); break;
        default: blend<0>(rgba, coverage, count, rgb, stroke_opacity, layer_opacity);
    }
}

extern "C" void blend_rgba_region(unsigned char *rgba, const float *coverage, unsigned rgba_width,
                                  unsigned left, unsigned top, unsigned stride, unsigned width, unsigned height,
                                  unsigned rgb, double stroke_opacity, double layer_opacity, int mode) {
    switch (mode) {
        case 1: blend_region<1>(rgba, coverage, rgba_width, left, top, stride, width, height,
                                rgb, stroke_opacity, layer_opacity); break;
        case 2: blend_region<2>(rgba, coverage, rgba_width, left, top, stride, width, height,
                                rgb, stroke_opacity, layer_opacity); break;
        case 3: blend_region<3>(rgba, coverage, rgba_width, left, top, stride, width, height,
                                rgb, stroke_opacity, layer_opacity); break;
        case 4: blend_region<4>(rgba, coverage, rgba_width, left, top, stride, width, height,
                                rgb, stroke_opacity, layer_opacity); break;
        default:
            if (width * height >= 65536) {
                blend_large_normal_region(rgba, coverage, rgba_width, left, top, stride, width, height,
                                          rgb, stroke_opacity, layer_opacity);
            } else {
                blend_region<0>(rgba, coverage, rgba_width, left, top, stride, width, height,
                                rgb, stroke_opacity, layer_opacity);
            }
    }
}
