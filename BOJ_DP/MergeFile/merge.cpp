#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>

int main() {
	int T, N;
	int cost[500];
	int d[501][501];
	scanf("%d", &T);

	for (int t = 0; t < T; t++) {
		scanf("%d", &N);
		for (int n = 0; n < N; n++) {
			scanf("%d", cost + n);
			
		}
		
		for (int n = 1; n <= 500; n += 2) {

		}
		printf("%d\n", d[N - 1]);
	}
	
	return 0;
}
