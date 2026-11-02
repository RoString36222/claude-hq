/*
 * bighead_geom.c — standalone C99 verifier for the Big Head totem's hitbox.
 *
 * WHAT THIS IS: a new standalone program (C99). It is NOT part of the web
 * application and is never loaded by the browser. games/strike.js
 * (STRIKE-SHARED) and backend/src/strike.rs are the shipped twins a browser and
 * the Arena actually run; a browser cannot execute C99 and AGENTS.md invariant 1
 * forbids a build step that would compile one, so this file exists only to
 * re-prove the geometry numbers independently of both of those.
 *
 * THE CONTRACT (must stay identical to hitBoxes / hit_boxes):
 *   s = 1 ordinary, s = BIG_HEAD_S (2) while the window is open.
 *   hr = HEAD_R * s                           half-width
 *   ht = BODY_H + (HEAD_TOP - BODY_H) * s     top
 *   head BOTTOM stays at BODY_H — a chest shot can never become a headshot
 *   the body box never moves
 *
 * Build:  cc -std=c99 -Wall -Wextra -O2 tools/bighead_geom.c -o /tmp/bighead_geom
 * Run:    /tmp/bighead_geom            (exit 0 == every check passed)
 */
#include <stdio.h>
#include <math.h>

/* STRIKE-SHARED constants — keep in step with games/strike.js and backend/src/strike.rs. */
#define BODY_R    0.4
#define BODY_H    1.40
#define HEAD_R    0.25
#define HEAD_TOP  1.90
#define BIG_HEAD_S 2.0
#define BIG_HEAD  10.0

typedef struct { double x0, y0, z0, x1, y1, z1; } Box;

/* Twin of hitBoxes / hit_boxes. hs <= 0 is treated as 1, matching the JS guard. */
static void hit_boxes(double x, double y, double z, double hs, Box *body, Box *head)
{
    double s = (hs > 0) ? hs : 1.0;
    double hr = HEAD_R * s;
    double ht = BODY_H + (HEAD_TOP - BODY_H) * s;
    body->x0 = x - BODY_R; body->y0 = y;          body->z0 = z - BODY_R;
    body->x1 = x + BODY_R; body->y1 = y + BODY_H; body->z1 = z + BODY_R;
    head->x0 = x - hr;     head->y0 = y + BODY_H; head->z0 = z - hr;
    head->x1 = x + hr;     head->y1 = y + ht;     head->z1 = z + hr;
}

static int eq(double a, double b) { return fabs(a - b) < 1e-9; }

/* Is the aim point inside b? */
static int inside(const Box *b, double px, double py, double pz)
{
    return px >= b->x0 && px <= b->x1 && py >= b->y0 && py <= b->y1
        && pz >= b->z0 && pz <= b->z1;
}

static int fails = 0;
static void check(const char *what, int ok)
{
    printf("  %s %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) fails++;
}

int main(void)
{
    Box b1, h1, b2, h2;
    double x = 0.0, y = 0.0, z = -10.0;   /* victim on the centreline, 10 m downrange */

    printf("bighead geometry — BIG_HEAD_S=%.1f, BIG_HEAD=%.1fs\n\n", BIG_HEAD_S, BIG_HEAD);

    hit_boxes(x, y, z, 1.0, &b1, &h1);
    hit_boxes(x, y, z, BIG_HEAD_S, &b2, &h2);

    printf("ordinary  head  x[%.2f,%.2f] y[%.2f,%.2f] z[%.2f,%.2f]\n",
           h1.x0, h1.x1, h1.y0, h1.y1, h1.z0, h1.z1);
    printf("big head  head  x[%.2f,%.2f] y[%.2f,%.2f] z[%.2f,%.2f]\n",
           h2.x0, h2.x1, h2.y0, h2.y1, h2.z0, h2.z1);
    printf("ordinary  body  x[%.2f,%.2f] y[%.2f,%.2f]\n", b1.x0, b1.x1, b1.y0, b1.y1);
    printf("big head  body  x[%.2f,%.2f] y[%.2f,%.2f]\n\n", b2.x0, b2.x1, b2.y0, b2.y1);

    /* 1. the head grows outward and upward only */
    check("head half-width 0.25 -> 0.50",
          eq(h1.x1 - x, HEAD_R) && eq(h2.x1 - x, HEAD_R * BIG_HEAD_S));
    check("head top 1.90 -> 2.40", eq(h1.y1, HEAD_TOP) && eq(h2.y1, 2.40));
    check("head top formula BODY_H + (HEAD_TOP-BODY_H)*s",
          eq(h2.y1, BODY_H + (HEAD_TOP - BODY_H) * BIG_HEAD_S));
    check("head BOTTOM stays on the shoulders", eq(h1.y0, BODY_H) && eq(h2.y0, BODY_H));

    /* 2. the body box never moves — a chest shot can never become a headshot */
    check("body box identical at both scales",
          eq(b1.x0, b2.x0) && eq(b1.x1, b2.x1) && eq(b1.y0, b2.y0) && eq(b1.y1, b2.y1)
          && eq(b1.z0, b2.z0) && eq(b1.z1, b2.z1));
    check("body width is 2*BODY_R (0.80)", eq(b1.x1 - b1.x0, 2.0 * BODY_R) && eq(b2.x1 - b2.x0, 2.0 * BODY_R));

    /* 3. a near-miss beside an ordinary skull is a headshot on a big one */
    {
        double ox = 0.38, oy = 1.65, oz = -10.0;
        int ord = inside(&h1, ox, oy, oz);
        int big = inside(&h2, ox, oy, oz);
        printf("  aim x=%.2f y=%.2f: ordinary %s, big %s\n",
               ox, oy, ord ? "HIT" : "MISS", big ? "HIT" : "MISS");
        check("0.38 m near-miss misses the ordinary skull", !ord);
        check("0.38 m near-miss lands on the big skull", big);
    }

    /* 4. a shot over the ordinary skull but inside the big one */
    {
        double ox = 0.35, oy = 2.05, oz = -10.0;
        int ord = inside(&h1, ox, oy, oz);
        int big = inside(&h2, ox, oy, oz);
        printf("  aim x=%.2f y=%.2f: ordinary %s, big %s\n",
               ox, oy, ord ? "HIT" : "MISS", big ? "HIT" : "MISS");
        check("2.05 m is over the ordinary skull", !ord);
        check("2.05 m is inside the big skull", big);
    }

    /* 5. chest shots stay body hits at both scales */
    {
        int i;
        double ys[2];
        ys[0] = 1.00; ys[1] = 1.35;
        for (i = 0; i < 2; i++) {
            double oy = ys[i];
            int b_ord = inside(&b1, 0.0, oy, -10.0);
            int b_big = inside(&b2, 0.0, oy, -10.0);
            int h_ord = inside(&h1, 0.0, oy, -10.0);
            int h_big = inside(&h2, 0.0, oy, -10.0);
            printf("  chest y=%.2f: body ord=%d big=%d, head ord=%d big=%d\n",
                   oy, b_ord, b_big, h_ord, h_big);
            check("chest is a body hit at both scales", b_ord && b_big);
            check("chest is never a headshot", !h_ord && !h_big);
        }
    }

    /* 6. the guard: hs <= 0 degrades to 1, like the JS `(hs != null && hs > 0)` */
    {
        Box b0, h0;
        hit_boxes(x, y, z, 0.0, &b0, &h0);
        check("hs=0 degrades to ordinary", eq(h0.x1 - x, HEAD_R) && eq(h0.y1, HEAD_TOP));
    }

    printf("\n13 checks, %d failed\n", fails);
    return fails ? 1 : 0;
}
