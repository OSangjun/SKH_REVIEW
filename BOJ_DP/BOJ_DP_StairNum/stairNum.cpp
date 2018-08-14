#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>


int main() {
	int N;
	unsigned long long dp[101][11] = { 0 };

	// get input
	scanf("%d", &N);

	// init
	dp[1][0] = 0;
	for (int i =1; i < 10; i++) {
		dp[1][i] = 1;
	}

	// dp
	for (int i = 2; i <= N; i++) {
		/*dp[i][0] = dp[i - 1][1] % 1000000000;
		dp[i][1] = dp[i - 1][8] % 1000000000;*/
		for (int j = 0; j <= 9; j++) {
			if (j == 9) {
				dp[i][9] = dp[i-1][8] % 1000000000 ;
			} else if (j == 0) {
				dp[i][0] = dp[i-1][1] % 1000000000 ; 
			}
			else {
				dp[i][j] = (dp[i - 1][j - 1] + dp[i - 1][j + 1]) % 1000000000;
			}
#ifdef _DEBUG
			printf("%10d ", dp[i][j]);
#endif
		}
#ifdef _DEBUG
		printf("\n");
#endif
	}

	
	// printf result
	int sum = 0;
	for (int i = 0; i <= 9; i++) {
		sum = (sum + dp[N][i])% 1000000000;
	}
	printf("%d", sum );

#ifdef _DEBUG
	system("pause");
#endif
	return 0;
}
