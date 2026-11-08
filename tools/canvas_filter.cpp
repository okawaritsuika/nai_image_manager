// Freestanding kernel used on buffers owned by the editor worker's WASM heap.
using BytePixel = unsigned char __attribute__((vector_size(4)));
using FloatPixel = float __attribute__((vector_size(16)));
using UIntPixel = unsigned __attribute__((vector_size(16)));
using IntPixel = int __attribute__((vector_size(16)));

extern "C" void blend_normal_rgba(
    const BytePixel* base, const BytePixel* changed, const unsigned char* mask,
    BytePixel* output, unsigned pixels, float opacity
) {
    for (unsigned i = 0; i < pixels; ++i) {
        const BytePixel source = base[i];
        const FloatPixel a = __builtin_convertvector(source, FloatPixel) / 255.0f;
        const FloatPixel b = __builtin_convertvector(changed[i], FloatPixel) / 255.0f;
        const float strength = (mask[i] / 255.0f) * opacity;
        const FloatPixel mixed = a + (b - a) * strength;
        BytePixel result = __builtin_convertvector(mixed * 255.0f + .5f, BytePixel);
        result[3] = source[3];
        output[i] = result;
    }
}

namespace {
int edge(int value, int length) {
    return value < 0 ? 0 : value >= length ? length - 1 : value;
}

struct BoxWeights {
    int radius;
    unsigned center;
    unsigned outer;
};

BoxWeights gaussianBox(float sigma) {
    // Extended box weights and rounding used by Pillow's three-pass Gaussian.
    const float variance = sigma * sigma / 3.0f;
    const float length = __builtin_sqrt(12.0 * variance + 1.0);
    const int whole = static_cast<int>((length - 1.0) / 2.0);
    float fraction = (2 * whole + 1) * (whole * (whole + 1) - 3.0f * variance);
    fraction /= 6.0f * (variance - (whole + 1) * (whole + 1));
    const float radius = whole + fraction;
    const int integerRadius = static_cast<int>(radius);
    const unsigned center = (1u << 24) / (radius * 2.0f + 1.0f);
    return {integerRadius, center, ((1u << 24) - (2 * integerRadius + 1) * center) / 2};
}

void boxLine(const BytePixel* src, BytePixel* dst, int length, BoxWeights weights) {
    const int radius = weights.radius;
    UIntPixel sum = __builtin_convertvector(src[0], UIntPixel) * (radius + 1u);
    for (int offset = 1; offset <= radius; ++offset) {
        sum += __builtin_convertvector(src[edge(offset, length)], UIntPixel);
    }
    auto output = [&](int x, int left, int right) {
        const UIntPixel a = __builtin_convertvector(src[left], UIntPixel);
        const UIntPixel b = __builtin_convertvector(src[right], UIntPixel);
        const UIntPixel fixed = sum * weights.center + (a + b) * weights.outer + (1u << 23);
        dst[x] = __builtin_convertvector(fixed >> 24, BytePixel);
        sum += b - __builtin_convertvector(src[edge(x - radius, length)], UIntPixel);
    };
    int x = 0;
    const int begin = radius + 1 < length ? radius + 1 : length;
    const int end = length - radius - 1;
    for (; x < begin; ++x) output(x, 0, edge(x + radius + 1, length));
    for (; x < end; ++x) output(x, x - radius - 1, x + radius + 1);
    for (; x < length; ++x) output(x, x - radius - 1, length - 1);
}

BytePixel unsharp(BytePixel base, BytePixel blurred, int percent, int threshold) {
    const IntPixel source = __builtin_convertvector(base, IntPixel);
    const IntPixel diff = source - __builtin_convertvector(blurred, IntPixel);
    const IntPixel sign = diff >> 31;
    const IntPixel magnitude = (diff ^ sign) - sign;
    const IntPixel product = magnitude * percent;
    // The reciprocal can round up once for values through 255 * 250.
    const IntPixel estimate = (product * 5243) >> 19;
    const IntPixel quotient = estimate + (estimate * 100 > product);
    const IntPixel delta = ((quotient ^ sign) - sign) & (magnitude > threshold);
    const IntPixel zero = {};
    const IntPixel limit = {255, 255, 255, 255};
    const IntPixel pixel = __builtin_elementwise_min(__builtin_elementwise_max(source + delta, zero), limit);
    return __builtin_convertvector(pixel, BytePixel);
}
}

extern "C" void gaussian_rgba(
    const BytePixel* const* input, BytePixel* const* output,
    BytePixel* scratch, BytePixel* rowA, BytePixel* rowB,
    int width, int height, float sigma, int percent, int threshold
) {
    const BoxWeights weights = gaussianBox(sigma);
    for (int y = 0; y < height; ++y) {
        boxLine(input[y], rowA, width, weights);
        boxLine(rowA, rowB, width, weights);
        boxLine(rowB, output[y], width, weights);
    }
    constexpr int block = 16;
    for (int top = 0; top < height; top += block) {
        for (int left = 0; left < width; left += block) {
            for (int y = top; y < height && y < top + block; ++y) {
                for (int x = left; x < width && x < left + block; ++x) {
                    scratch[x * height + y] = output[y][x];
                }
            }
        }
    }
    for (int x = 0; x < width; ++x) {
        BytePixel* column = scratch + x * height;
        boxLine(column, rowA, height, weights);
        boxLine(rowA, rowB, height, weights);
        boxLine(rowB, column, height, weights);
    }
    for (int top = 0; top < height; top += block) {
        for (int left = 0; left < width; left += block) {
            for (int y = top; y < height && y < top + block; ++y) {
                for (int x = left; x < width && x < left + block; ++x) {
                    const BytePixel pixel = scratch[x * height + y];
                    output[y][x] = percent < 0 ? pixel : unsharp(input[y][x], pixel, percent, threshold);
                }
            }
        }
    }
}
