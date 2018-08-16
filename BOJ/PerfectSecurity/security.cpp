// https://www.acmicpc.net/problem/9322
// 18-08-16 19:00 ~ 19:29
#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>
#include <string.h>


int main() {
	int N, nWord;
	char openkey1[1000][11], openkey2[1000][11], code[1000][11];
	char *seq[1000];

	scanf("%d", &N);

	for (int n = 0; n < N; n++) {
		scanf("%d", &nWord);

		// 제 1 오픈키 입력
		for (int k = 0; k < nWord; k++) {
			scanf("%s", &openkey1[k]);
		}
		// 제 2 오픈키 입력
		for (int k = 0; k < nWord; k++) {
			scanf("%s", &openkey2[k]);
			for (int i = 0; i < nWord; i++) {
				if ( strcmp(openkey2[k], openkey1[i]) == 0 ) {
					seq[i] = code[k];
					break;
				}
			}
		}

		// 암호문 입력
		for (int k = 0; k < nWord; k++) {
			scanf("%s", &code[k]);
		}
		
		// 평문 출력
		for (int k = 0; k < nWord; k++) {
			printf("%s", seq[k]);
			if (k < nWord - 1) printf(" ");
		}
		printf("\n");
	}
#ifdef _DEBUG
	system("pause");
#endif

	return 0;
}