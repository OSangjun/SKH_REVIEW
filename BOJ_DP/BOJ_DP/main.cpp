#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>

int fac(int n) {
	if (n == 1) {
		return 1;
	}
	else if (n == 0) {
		return 0;
	}
	else {
		return n * fac(n - 1);
	}
}

int main() {
	int T, t, n, k;
	
	scanf("%d", &T);
	for (t = 0; t < T; t++) {
		// 2 <= n <= 100
		// 0 <= k <= 99
		scanf("%d %d", &n,&k);

	}

	return 0;
}